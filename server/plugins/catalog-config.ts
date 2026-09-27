import type { CatalogSource } from './memoria-plugin/src/packages/acquisition.js';

/** Catalog connectivity is optional; local installed apps never need this configuration. */
export function pluginCatalogSource(env: NodeJS.ProcessEnv = process.env): CatalogSource | undefined {
  const value = env.MEMORIA_PLUGIN_CATALOG_URL;
  if (!value) {
    if (env.MEMORIA_PLUGIN_CATALOG_TOKEN) throw new Error('Plugin catalog token requires a catalog URL');
    return undefined;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Plugin catalog URL must be HTTPS without credentials, query or fragment');
  }
  return { url: url.href, headers: env.MEMORIA_PLUGIN_CATALOG_TOKEN
    ? { Authorization: `Bearer ${env.MEMORIA_PLUGIN_CATALOG_TOKEN}` } : undefined };
}
