// Preload script — runs in the renderer's isolated world before any page
// scripts. We expose a tiny `window.memoria` API so the web UI can:
//   - check / toggle "start at login" without us having to ship a native
//     settings UI
//   - hide the window into the tray (mirroring the close button)
//   - cleanly quit (vs. just hiding) the whole app
//   - read the server port (for diagnostics in the AI/設定 panel)
//
// Everything else (REST API to the Memoria server) goes through plain
// `fetch('/api/...')` against http://localhost:<port>/, exactly as in
// the browser. No Node integration, no renderer-side filesystem.

import { contextBridge, ipcRenderer } from 'electron';

interface MemoriaBridge {
  /** Returns true if the OS is configured to auto-launch Memoria at login. */
  getAutoLaunch: () => Promise<boolean>;
  /** Toggle OS auto-launch. Returns the resulting state. */
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  /** The port the Memoria server is listening on (default 5180). */
  getServerPort: () => Promise<number>;
  /** Hide the window into the tray (the server keeps running). */
  hide: () => Promise<void>;
  /** Fully quit the app — kills the server too. */
  quit: () => Promise<void>;
}

const api: MemoriaBridge = {
  getAutoLaunch: () => ipcRenderer.invoke('memoria:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('memoria:set-auto-launch', enabled),
  getServerPort: () => ipcRenderer.invoke('memoria:get-server-port'),
  hide: () => ipcRenderer.invoke('memoria:hide'),
  quit: () => ipcRenderer.invoke('memoria:quit'),
};

contextBridge.exposeInMainWorld('memoria', api);

// Type augmentation for renderer code that uses `window.memoria`. Renderer
// code lives in server/public/ which has its own (loose) JS, so this is
// only useful when/if that side is ever migrated to TS.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface Window {
    memoria: MemoriaBridge;
  }
}
