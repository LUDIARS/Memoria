import { build } from 'esbuild';

/**
 * Breakaway-safe production entrypoint for Excubitor.
 *
 * This preserves the frontend build performed by npm's `prestart` lifecycle
 * while allowing the catalog to invoke tsx through node directly on Windows.
 */
async function bootstrap(): Promise<void> {
  await build({
    entryPoints: ['public/src/app.ts'],
    bundle: true,
    outfile: 'public/app.js',
    target: 'es2020',
    sourcemap: true,
    minify: true,
  });

  await import('./bootstrap.js');
}

void bootstrap().catch((error: unknown) => {
  console.error('[excubitor-bootstrap] fatal:', error);
  process.exitCode = 1;
});
