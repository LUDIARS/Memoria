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
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';

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

  const env: NodeJS.ProcessEnv = { ...process.env, MEMORIA_PORT: String(port) };
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const bash = discoverGitBashWindows();
    if (bash) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bash;
      console.log('[memoria-desktop] git-bash →', bash);
    }
  }

  const child = spawn(nodeBin, ['index.js'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  child.on('error', (e: Error) => {
    console.error(`[memoria-desktop] failed to spawn server (${nodeBin} index.js in ${serverDir}):`, e.message);
  });
  child.on('exit', (code, signal) => {
    console.log(`[memoria-desktop] server exited (code=${code}, signal=${signal ?? ''})`);
    serverChild = null;
  });
  console.log(`[memoria-desktop] spawned ${nodeBin} (pid ${child.pid}) in ${serverDir} (port ${port}, runAsNode=${runAsNode})`);
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

// ── IPC bridge (preload talks to us via these channels) ───────────────────

ipcMain.handle('memoria:get-auto-launch', () => getAutoLaunch());
ipcMain.handle('memoria:set-auto-launch', (_event, enabled: unknown) => {
  setAutoLaunch(Boolean(enabled));
  return getAutoLaunch();
});
ipcMain.handle('memoria:get-server-port', () => serverPort);
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
  serverChild = spawnServer(serverPort);
  // Even if spawn returned null (e.g. user runs server externally) we still
  // poll readiness — the URL might already be responding.
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
    if (!serverChild) serverChild = spawnServer(serverPort);
    await waitForServerReady(serverPort, 25_000);
    createWindow(serverPort);
  }
});
