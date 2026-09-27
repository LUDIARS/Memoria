import type { PluginRegistry } from './memoria-plugin/host/registry.js';

/** Stop accepting activations and drain plugin-owned jobs/connections before process exit. */
export function registerPluginShutdown(registry: PluginRegistry, stopServices: () => void): void {
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try { stopServices(); await registry.dispose(); process.exitCode = 0; }
    catch { process.emitWarning('Plugin shutdown failed', { code: 'MEMORIA_PLUGIN' }); process.exitCode = 1; }
    process.exit(process.exitCode);
  }
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
