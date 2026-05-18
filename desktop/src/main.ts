// Memoria Electron entry point.
//
// Spawns the Memoria Node server (server/index.js) as a child process and
// loads http://localhost:<MEMORIA_PORT>/ in a BrowserWindow. The server
// itself is treated as **always-on**: closing the window only hides it
// (the process keeps running in the system tray), and OS login can be
// configured to auto-launch the app in `--hidden` mode so the server
// becomes a permanent background service for Chrome extension /
// PWA / mobile clients to talk to.
//
// Spawn behaviour is controlled by env vars / build mode:
//   MEMORIA_SERVER_DIR  — absolute path to the server/ directory.
//                          Default lookup order:
//                            1. process.resourcesPath/server  (packaged)
//                            2. ../server                      (dev)
//   MEMORIA_NODE_BIN    — Node executable.
//                          Default lookup order:
//                            1. process.resourcesPath/node/<plat>/...  (packaged)
//                            2. `node` on PATH (dev)
//                            3. process.execPath of the running Electron
//                               (run as Node by passing ELECTRON_RUN_AS_NODE=1)
//   MEMORIA_PORT        — port the server listens on (default: 5180)
//
// Command-line flags:
//   --hidden            — start without showing the main window. The
//                          server still spawns and the tray icon is
//                          installed; the user opens the window from the
//                          tray when they want to interact. Used by the
//                          OS login auto-start integration.

import { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';

const execFileP = promisify(execFile);

// ── single instance ───────────────────────────────────────────────────────
// Only one Memoria desktop at a time per user — the second launch focuses
// the existing window so two instances don't fight over the port.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const startHidden = process.argv.includes('--hidden');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverChild: ChildProcess | null = null;
let isQuitting = false;
let serverPort = Number(process.env.MEMORIA_PORT) || 5180;
let pendingUpdateVersion: string | null = null;

type NodeSubdir =
  | 'win-x64'
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'unknown';

function targetNodeSubdir(): NodeSubdir {
  const a = process.arch;
  if (process.platform === 'win32' && a === 'x64') return 'win-x64';
  if (process.platform === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && a === 'x64') return 'darwin-x64';
  if (process.platform === 'linux' && a === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && a === 'arm64') return 'linux-arm64';
  return 'unknown';
}

function bundledNode(): string | null {
  // electron-builder copies extraResources to:
  //   - production: process.resourcesPath/node/<plat>/...
  //   - dev (when running `electron .`): not present, fallback path used
  if (!process.resourcesPath) return null;
  const base = path.join(process.resourcesPath, 'node', targetNodeSubdir());
  const candidates = [
    path.join(base, 'node.exe'),
    path.join(base, 'bin', 'node'),
    path.join(base, 'node'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function bundledServerDir(): string | null {
  if (!process.resourcesPath) return null;
  const p = path.join(process.resourcesPath, 'server');
  return fs.existsSync(p) ? p : null;
}

function devServerDir(): string | null {
  // In `electron .` from desktop/, the sibling server/ is at ../server.
  // After tsc the running file lives at desktop/out/main.js, so .. resolves
  // to desktop/, and then ../server is the right repo dir.
  const p = path.resolve(__dirname, '..', '..', 'server');
  return fs.existsSync(p) ? p : null;
}

function findNodeOnPath(): string | null {
  // Sync `which`-equivalent so we never start the server with Electron's
  // own Node binary unless we deliberately mean to. Native modules in
  // server/node_modules (better-sqlite3) are compiled against a specific
  // NODE_MODULE_VERSION; mixing host Node 22 with Electron's bundled
  // Node 20 throws ERR_DLOPEN_FAILED at startup.
  const pathEnv = process.env.PATH || process.env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'node' + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function discoverGitBashWindows(): string | null {
  // Best-effort discovery so the bundled Claude CLI (spawned from Node)
  // can find its own bash on Windows. Settings can override.
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (process.env.USERPROFILE) {
    const p = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

interface ServerLayout {
  serverDir: string | null;
  nodeBin: string;
  runAsNode: boolean;
}

function resolveServerLayout(): ServerLayout {
  const serverDir = process.env.MEMORIA_SERVER_DIR
    || bundledServerDir()
    || devServerDir();

  // Resolution order:
  //   1. MEMORIA_NODE_BIN env override
  //   2. Bundled portable Node from resources/node/<plat>/ (production)
  //   3. `node` on PATH (dev mode — matches the version server's native
  //      modules were built against)
  //   4. Electron's own Node via ELECTRON_RUN_AS_NODE=1 (last-resort
  //      fallback — works only if better-sqlite3 et al. happen to match
  //      Electron's NODE_MODULE_VERSION, otherwise ERR_DLOPEN_FAILED)
  let nodeBin = process.env.MEMORIA_NODE_BIN
    || bundledNode()
    || findNodeOnPath();
  let runAsNode = false;
  if (!nodeBin) {
    nodeBin = process.execPath;
    runAsNode = true;
  }
  return { serverDir, nodeBin, runAsNode };
}

function spawnServer(port: number): ChildProcess | null {
  const { serverDir, nodeBin, runAsNode } = resolveServerLayout();
  if (!serverDir) {
    console.warn('[memoria-desktop] server dir not found — assuming an external server is already running');
    return null;
  }

  // Memoria server は TypeScript (`index.ts`)。 dev / 同梱 (npm install --omit=dev
  // で tsx が入っている) どちらも `tsx` CLI 経由で起動する。 旧コードは `index.js`
  // を指定していたが、 server 側に compile step が無いので spawn が即終了して
  // いた (= 結果、 別途 `npm start` で立てた standalone server に Electron が
  // フォールバック接続するという紛らわしい状態になっていた)。
  const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    console.error(`[memoria-desktop] tsx CLI not found at ${tsxCli}. Run \`npm install\` in ${serverDir}.`);
    return null;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, MEMORIA_PORT: String(port) };
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const bash = discoverGitBashWindows();
    if (bash) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bash;
      console.log('[memoria-desktop] git-bash →', bash);
    }
  }

  // tsx CLI に server/index.ts を渡す。 `--env-file-if-exists` は `npm start` と
  // 同じ二段読み (server/.env と repo-root/.env)。
  const args = [
    tsxCli,
    '--env-file-if-exists=.env',
    '--env-file-if-exists=../.env',
    'index.ts',
  ];

  const child = spawn(nodeBin, args, {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  child.on('error', (e: Error) => {
    console.error(`[memoria-desktop] failed to spawn server (${nodeBin} ${tsxCli} index.ts in ${serverDir}):`, e.message);
  });
  child.on('exit', (code, signal) => {
    console.log(`[memoria-desktop] server exited (code=${code}, signal=${signal ?? ''})`);
    serverChild = null;
  });
  console.log(`[memoria-desktop] spawned ${nodeBin} ${tsxCli} index.ts (pid ${child.pid}) in ${serverDir} (port ${port}, runAsNode=${runAsNode})`);
  return child;
}

async function waitForServerReady(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/queue`;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        // 200 / 401 / 404 — anything that means "the server answered" is fine.
        // Memoria's /api/queue is unauthenticated and very cheap.
        res.resume();
        resolve(res.statusCode != null && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow(serverPort);
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'Memoria',
    show: false,                // shown after the window finishes loading
    backgroundColor: '#fafbfd',
    autoHideMenuBar: true,      // hide the default Electron menu (still toggleable with Alt)
    icon: trayIconPath() ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Strip the default menu entirely on production builds — Memoria has its
  // own UI; the File/Edit/View menubar adds nothing.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  // Open external links in the user's default browser instead of a new
  // BrowserWindow (which would otherwise try to load with our process'
  // privileges + cookies).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // **Closing the window does NOT quit the app.** The Memoria server is
  // meant to stay running in the background so the Chrome extension /
  // mobile PWA can hit /api/* at any time. We hide the window and keep
  // the tray icon as the only entry point. The user can quit fully from
  // the tray menu (which sets isQuitting before calling app.quit).
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  void mainWindow.loadURL(`http://localhost:${port}/`);
}

// ── tray ──────────────────────────────────────────────────────────────────

function trayIconPath(): string | null {
  // Tray needs a small (16-32 px) image. We have placeholder PNGs in icons/,
  // and in the packaged build electron-builder ships them under either
  // <resources>/app.asar/icons/ or <resources>/icons/ depending on the
  // asar setting. Try the dev path first, then the packaged variants.
  const candidates: string[] = [
    path.resolve(__dirname, '..', 'icons', '32x32.png'),                  // dev: out/main.js → desktop/icons/
    path.join(process.resourcesPath || '', 'app.asar', 'icons', '32x32.png'),
    path.join(process.resourcesPath || '', 'app', 'icons', '32x32.png'),
    path.join(process.resourcesPath || '', 'icons', '32x32.png'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function buildTrayMenu(): Menu {
  const loginItem = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    {
      label: 'Memoria を開く',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'ログイン時に自動起動',
      type: 'checkbox',
      checked: loginItem.openAtLogin,
      click: (item) => setAutoLaunch(item.checked),
    },
    { type: 'separator' },
    pendingUpdateVersion
      ? {
          label: `更新 v${pendingUpdateVersion} を適用して再起動`,
          click: () => {
            isQuitting = true;
            autoUpdater.quitAndInstall();
          },
        }
      : {
          label: '更新を確認',
          click: () => { void checkForUpdatesManually(); },
        },
    { type: 'separator' },
    {
      label: 'Memoria を終了',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  const iconPath = trayIconPath();
  if (!iconPath) {
    console.warn('[memoria-desktop] tray icon not found — tray will not be installed');
    return;
  }
  // Resize to a sensible tray size; on macOS dark mode the auto-template
  // would be nicer, but the placeholder is a solid colour so it's fine.
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Memoria — クリックで開く');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

// ── auto-update (electron-updater + GitHub Releases) ──────────────────────
// build.publish に { provider: 'github', owner: LUDIARS, repo: Memoria } を
// 指定してあるので、 autoUpdater は https://github.com/LUDIARS/Memoria の
// 最新 Release に置いてある latest.yml / latest-mac.yml / latest-linux.yml を
// 読みに行く。 これらは electron-builder の --publish=always が自動で生成して
// Release に upload する。 起動から数秒後に silent check し、 6 時間ごとに
// 再チェック。 更新が降ってきたら background download → quit 時に install。
// Tray menu からは手動チェック + 「適用して再起動」 が出来る。

function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    console.log('[updater] disabled in dev mode (app not packaged)');
    return;
  }
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up-to-date:', info.version);
  });
  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err instanceof Error ? err.message : String(err));
  });
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading… ${Math.round(p.percent)}%`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version, '— ready to install');
    pendingUpdateVersion = info.version;
    refreshTrayMenu();
  });

  // UI 起動と被らないよう 5 秒遅延、 以降 6h 毎
  setTimeout(() => { void autoUpdater.checkForUpdatesAndNotify(); }, 5_000);
  setInterval(() => { void autoUpdater.checkForUpdatesAndNotify(); }, 6 * 60 * 60 * 1000);
}

async function checkForUpdatesManually(): Promise<void> {
  if (!app.isPackaged) {
    console.log('[updater] manual check skipped (dev mode)');
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    console.log('[updater] manual check →', result?.updateInfo?.version ?? '(no info)');
  } catch (e) {
    console.warn('[updater] manual check failed:', e instanceof Error ? e.message : String(e));
  }
}

// ── auto-launch ────────────────────────────────────────────────────────────
// We register the app to start at login with `--hidden` so the Memoria
// server boots silently in the background. The user can open the window
// any time from the tray icon. macOS / Linux are handled the same way by
// Electron's setLoginItemSettings (which falls back to LaunchAgent /
// xdg-autostart respectively). On Linux the .desktop file approach
// requires the app to be packaged as an AppImage / .deb that registers
// itself; in dev mode this call is a no-op.

function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: enabled ? ['--hidden'] : [],
  });
  refreshTrayMenu();
  console.log(`[memoria-desktop] auto-launch → ${enabled}`);
}

function getAutoLaunch(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

// ── WiFi info (Electron 起動時の SSID matching 用) ─────────────────────────
//
// renderer (Memoria web UI) からは `window.memoria.getCurrentWifiInfo()` で
// 呼ばれる。 接続中の WiFi SSID と BSSID を返す。 取れなければ null。
//
// 各 OS で native CLI を叩く:
//   Windows : `netsh wlan show interfaces` の "SSID" / "BSSID" 行をパース
//   macOS   : `networksetup -getairportnetwork en0` (SSID のみ取れる)
//             modern macOS は `airport -I` も使えるが path がバージョン依存
//   Linux   : `iwgetid -r` (SSID) と `iwgetid -ar` (BSSID)、 無ければ nmcli
//
// すべて読み取り専用コマンド (= 状態を変えない)。 失敗時は null。
export interface WifiInfo { ssid: string | null; bssid: string | null; platform: string }

async function getCurrentWifiInfo(): Promise<WifiInfo | null> {
  const platform = process.platform;
  try {
    if (platform === 'win32') return await wifiInfoWindows();
    if (platform === 'darwin') return await wifiInfoMac();
    if (platform === 'linux') return await wifiInfoLinux();
  } catch (err) {
    console.warn('[wifi-info] failed:', (err as Error).message);
  }
  return null;
}

async function wifiInfoWindows(): Promise<WifiInfo | null> {
  // chcp 65001 → UTF-8。 日本語版 Windows の cp932 出力で正規表現が壊れるのを回避
  const r = await execFileP('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', windowsHide: true });
  const out = r.stdout || '';
  // 日本語版 ("SSID" → "プロファイル" や "SSID" のまま) 両方を拾えるよう、
  // ": <value>" の前に行頭の半角 / 全角空白を許容する正規表現で取る。
  // BSSID と SSID の判別は順序で行う (BSSID は SSID の直後に出る)。
  const lines = out.split(/\r?\n/);
  let ssid: string | null = null;
  let bssid: string | null = null;
  for (const line of lines) {
    const m = /^\s*(?:SSID|BSSID)\b[^\:]*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    // BSSID 行は前置に「BSSID」 を含む。 SSID 行のみ純粋な「SSID」 で始まる。
    if (/^\s*BSSID/.test(line) && !bssid) bssid = m[1] ?? null;
    else if (/^\s*SSID/.test(line) && !ssid) ssid = m[1] ?? null;
    if (ssid && bssid) break;
  }
  return ssid || bssid ? { ssid, bssid, platform: 'win32' } : null;
}

async function wifiInfoMac(): Promise<WifiInfo | null> {
  // networksetup は信頼性が高い (sudo 不要)。 SSID のみ。 BSSID は別経路 (airport -I)
  // で取れるが、 macOS Sonoma 以降は restricted のためベストエフォート。
  try {
    const r = await execFileP('networksetup', ['-getairportnetwork', 'en0'], { encoding: 'utf8' });
    const m = /Current Wi-Fi Network:\s*(.+?)\s*$/m.exec(r.stdout || '');
    const ssid = m?.[1] ?? null;
    let bssid: string | null = null;
    try {
      const apt = await execFileP('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport', ['-I'], { encoding: 'utf8' });
      const b = /\bBSSID:\s*([0-9a-f:]+)\s*$/im.exec(apt.stdout || '');
      bssid = b?.[1] ?? null;
    } catch { /* airport restricted on newer macOS */ }
    return ssid ? { ssid, bssid, platform: 'darwin' } : null;
  } catch {
    return null;
  }
}

async function wifiInfoLinux(): Promise<WifiInfo | null> {
  // iwgetid: -r で SSID 単独、 -ar で BSSID 単独。 net-tools / wireless-tools 系。
  let ssid: string | null = null;
  let bssid: string | null = null;
  try { const r = await execFileP('iwgetid', ['-r'], { encoding: 'utf8' }); ssid = r.stdout.trim() || null; } catch { /* try nmcli */ }
  try { const r = await execFileP('iwgetid', ['-ar'], { encoding: 'utf8' }); bssid = r.stdout.trim() || null; } catch { /* skip */ }
  if (!ssid) {
    try {
      const r = await execFileP('nmcli', ['-t', '-f', 'active,ssid,bssid', 'dev', 'wifi'], { encoding: 'utf8' });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        // nmcli の bssid フィールド内 ':' は '\\:' で escape されているので強引に分解
        const parts = line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':'));
        if (parts[0] === 'yes') { ssid = parts[1] || ssid; bssid = parts[2] || bssid; break; }
      }
    } catch { /* nmcli 不在 */ }
  }
  return ssid || bssid ? { ssid, bssid, platform: 'linux' } : null;
}

// ── IPC bridge (preload talks to us via these channels) ───────────────────

ipcMain.handle('memoria:get-auto-launch', () => getAutoLaunch());
ipcMain.handle('memoria:set-auto-launch', (_event, enabled: unknown) => {
  setAutoLaunch(Boolean(enabled));
  return getAutoLaunch();
});
ipcMain.handle('memoria:get-server-port', () => serverPort);
ipcMain.handle('memoria:get-wifi-info', () => getCurrentWifiInfo());
ipcMain.handle('memoria:quit', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.handle('memoria:hide', () => mainWindow?.hide());

// ── lifecycle ──────────────────────────────────────────────────────────────

function killServer(): void {
  if (!serverChild) return;
  try {
    if (process.platform === 'win32' && serverChild.pid != null) {
      // child_process .kill() on Windows can leave grandchildren orphaned.
      // taskkill the whole process tree.
      const tk = spawn('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('error', () => { try { serverChild?.kill(); } catch { /* ignore */ } });
    } else {
      serverChild.kill('SIGTERM');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[memoria-desktop] kill failed:', msg);
  } finally {
    serverChild = null;
  }
}

app.on('second-instance', () => {
  // Second launch (e.g. user double-clicked the desktop shortcut while we
  // were already in the tray) — surface the window.
  showWindow();
});

void app.whenReady().then(async () => {
  serverPort = Number(process.env.MEMORIA_PORT) || 5180;
  // 既に外で server が立っている場合 (= dev で `npm start` を別途走らせている等)
  // は spawn を skip。 そうでなければ Electron が backend を自分で立てる。
  const externalAlive = await waitForServerReady(serverPort, 500);
  if (externalAlive) {
    console.log(`[memoria-desktop] external server detected on :${serverPort} — skipping spawn (Electron will share the existing server)`);
  } else {
    serverChild = spawnServer(serverPort);
  }
  const ready = await waitForServerReady(serverPort, 25_000);
  if (!ready) {
    console.warn(`[memoria-desktop] server on :${serverPort} did not become ready in time — opening the window anyway; the WebView will retry`);
  }
  createTray();
  if (!startHidden) {
    createWindow(serverPort);
  } else {
    console.log('[memoria-desktop] --hidden flag set — staying in the tray (no window)');
  }
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // Memoria server is meant to keep running. We deliberately do NOT call
  // app.quit() here on Win/Linux; the tray icon stays as the only UI.
  // (On macOS, the convention is the same — the app keeps running until
  // the user explicitly quits via Cmd+Q or the tray.)
});

app.on('before-quit', () => {
  isQuitting = true;
  killServer();
  // Drop the tray reference so it disappears immediately rather than
  // sticking around with a dead context menu.
  tray?.destroy();
  tray = null;
});

// macOS: re-create the window when the dock icon is clicked and there are
// no other windows open.
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!serverChild) {
      // 同じガード — 外で生きている server があれば spawn しない
      const alive = await waitForServerReady(serverPort, 500);
      if (!alive) serverChild = spawnServer(serverPort);
    }
    await waitForServerReady(serverPort, 25_000);
    createWindow(serverPort);
  }
});
