import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isSameMachineRequest } from '../lib/local-request.js';
import type { PluginPackages } from './memoria-plugin/host/package-service.js';
import type { PackageStore } from './memoria-plugin/src/packages/storage.js';
import { object, packageId, packageVersion, text } from './memoria-plugin/src/packages/contract.js';

export const pluginPackageAccess: MiddlewareHandler = async (c, next) => {
  const site = c.req.header('sec-fetch-site');
  if (!isSameMachineRequest(c) || (site && site !== 'same-origin' && site !== 'none') ||
      (c.req.method !== 'GET' && !c.req.header('origin'))) {
    return c.json({ ok: false, error: 'この端末の画面から操作してください。' }, 403);
  }
  c.header('Cache-Control', 'no-store');
  return next();
};

export interface PackageRouterDeps {
  packages: Pick<PluginPackages, 'catalog' | 'install' | 'useVersion' | 'uninstall'>;
  store: Pick<PackageStore, 'active'>;
  configured: boolean;
  sourceOrigin?: string;
}

export function makePluginPackageRouter(deps: PackageRouterDeps): Hono {
  const router = new Hono();
  router.use('/api/plugin-packages/*', pluginPackageAccess);
  router.use('/api/plugin-packages/*', bodyLimit({ maxSize: 4096 }));
  router.get('/api/plugin-packages/installed', async (c) => c.json({ ok: true,
    packages: (await deps.store.active()).map((item) => item.release.manifest) }));
  router.get('/api/plugin-packages/catalog', async (c) => {
    if (!deps.configured) return c.json({ ok: false, error: '配信先はまだ設定されていません。保存済みのアプリは利用できます。' }, 503);
    try { return c.json({ ok: true, sourceOrigin: deps.sourceOrigin, releases: await deps.packages.catalog() }); }
    catch { return c.json({ ok: false, error: '配信先から一覧を取得できません。保存済みのアプリは利用できます。' }, 502); }
  });
  router.post('/api/plugin-packages/install', async (c) => {
    try {
      const body = object(await c.req.json());
      if (body.trusted !== true) return c.json({ ok: false, error: '配布元と要求権限の確認が必要です。' }, 400);
      const digest = text(body.sha256, 'digest');
      if (!/^[a-f0-9]{64}$/.test(digest)) return c.json({ ok: false, error: 'パッケージの指定が不正です。' }, 400);
      await deps.packages.install(packageId(body.id), packageVersion(body.version), digest);
      return c.json({ ok: true });
    } catch { return c.json({ ok: false, error: 'パッケージを取得・有効化できませんでした。選択内容と配信先を確認してください。' }, 400); }
  });
  router.post('/api/plugin-packages/use-version', async (c) => {
    try {
      const body = object(await c.req.json());
      await deps.packages.useVersion(packageId(body.id), packageVersion(body.version));
      return c.json({ ok: true });
    } catch { return c.json({ ok: false, error: '保存済みのバージョンに切り替えられませんでした。' }, 400); }
  });
  router.post('/api/plugin-packages/uninstall', async (c) => {
    try {
      const body = object(await c.req.json());
      await deps.packages.uninstall(packageId(body.id));
      return c.json({ ok: true });
    } catch { return c.json({ ok: false, error: 'パッケージを解除できませんでした。' }, 400); }
  });
  return router;
}
