import {buildFrontend} from './frontend-build.js';

/**
 * Breakaway-safe production entrypoint for Excubitor.
 *
 * This preserves the frontend build performed by npm's `prestart` lifecycle
 * while allowing the catalog to invoke tsx through node directly on Windows.
 */
async function bootstrap(): Promise<void> {
  await buildFrontend();

  await import('./bootstrap.js');
}

void bootstrap().catch((error: unknown) => {
  console.error('[excubitor-bootstrap] fatal:', error);
  process.exitCode = 1;
});
