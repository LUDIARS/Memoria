// Preload script — runs in the renderer's isolated world before any page
// scripts. We deliberately expose nothing right now: Memoria's UI is a
// regular web app loaded over http://localhost:5180/, talks to its own
// REST API, and doesn't need any privileged Electron bridges.
//
// If we ever need IPC (e.g. native file dialogs, OS notifications routed
// through Electron's APIs, app version display), expose a small surface
// here via `contextBridge.exposeInMainWorld` rather than turning off
// contextIsolation.

// Currently a no-op. Keeping the file so main.ts's webPreferences.preload
// path always resolves and a future bridge has an obvious home.
export {};
