// Memoria Electron entry point.
//
// Spawns the Memoria Node server (server/index.js) as a child process and
// loads http://localhost:<MEMORIA_PORT>/ in a BrowserWindow. The server
// prints its readiness via stdout; we just poll the URL until it answers
// before showing the window so the user never sees the "couldn't connect"
// transient.
//
// Spawn behaviour is controlled by env vars / build mode:
//   MEMORIA_SERVER_DIR  — absolute path to the server/ directory.
//                          Default lookup order:
//                            1. process.resourcesPath/server  (packaged)
//                            2. ../server                      (dev)
//   MEMORIA_NODE_BIN    — Node executable.
//                          Default lookup order:
//                            1. process.resourcesPath/node/<plat>/...  (packaged)
//                            2. process.execPath of the running Electron
//                               (run as Node by passing ELECTRON_RUN_AS_NODE=1)
//                            3. "node" on PATH
//   MEMORIA_PORT        — port the server listens on (default: 5180)

import { app, BrowserWindow, shell, Menu } from 'electron';
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

let mainWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | null = null;

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

  let nodeBin = process.env.MEMORIA_NODE_BIN || bundledNode();
  let runAsNode = false;
  if (!nodeBin) {
    // Fallback: run Electron itself as Node via ELECTRON_RUN_AS_NODE=1.
    // This is what production builds rely on if the bundle script wasn't
    // run; it's the most portable "we always have a Node" option since
    // Electron ships its own.
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
  mainWindow.on('closed', () => { mainWindow = null; });

  void mainWindow.loadURL(`http://localhost:${port}/`);
}

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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

void app.whenReady().then(async () => {
  const port = Number(process.env.MEMORIA_PORT) || 5180;
  serverChild = spawnServer(port);
  // Even if spawn returned null (e.g. user runs server externally) we still
  // poll readiness — the URL might already be responding.
  const ready = await waitForServerReady(port, 25_000);
  if (!ready) {
    console.warn(`[memoria-desktop] server on :${port} did not become ready in time — opening the window anyway; the WebView will retry`);
  }
  createWindow(port);
});

app.on('window-all-closed', () => {
  killServer();
  // Mirror the macOS convention: keep the app alive on macOS unless the
  // user explicitly quits, but on Win/Linux quitting on last close is the
  // expected behaviour.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killServer);

// macOS: re-create the window when the dock icon is clicked and there are
// no other windows open.
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const port = Number(process.env.MEMORIA_PORT) || 5180;
    if (!serverChild) serverChild = spawnServer(port);
    await waitForServerReady(port, 25_000);
    createWindow(port);
  }
});
