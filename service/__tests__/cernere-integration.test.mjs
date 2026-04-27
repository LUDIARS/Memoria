// Integration test: Memoria's startCernere() vs FakeCernere.
//
// Skips automatically when @ludiars/cernere-service-adapter is not installed
// (private GitHub Packages — not available without NPM_TOKEN, e.g. in CI).
//
// Verifies:
//   1. Memoria's PeerAdapter starts and registers itself with Cernere.
//   2. A "fake imperativus" peer can invoke memoria.list_categories
//      and gets back a result from Memoria's handler.
//   3. emitEvent() succeeds when MEMORIA_HOOK_TARGET is configured and
//      a target peer is registered to receive events.emit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let SDK = null;
let FakeCernere = null;

try {
  SDK = await import('@ludiars/cernere-service-adapter');
  ({ FakeCernere } = await import('@ludiars/cernere-service-adapter/testing'));
} catch {
  // SDK absent — describe.skip below will turn the suite into a no-op.
}

const guard = SDK && FakeCernere ? describe : describe.skip;

guard('Memoria ↔ FakeCernere peer integration', () => {
  let cernere;
  let imperativus;
  let memoriaModule;
  let baseUrl;

  beforeAll(async () => {
    cernere = new FakeCernere({
      projects: [
        { projectKey: 'memoria',     clientId: 'memoria-cid', clientSecret: 'memoria-sec' },
        { projectKey: 'imperativus', clientId: 'imp-cid',     clientSecret: 'imp-sec' },
      ],
      relayPairs: [['memoria', 'imperativus']],
    });
    const out = await cernere.start();
    baseUrl = out.baseUrl;

    // Spin up our "fake imperativus" peer first so Memoria can address it.
    imperativus = new SDK.PeerAdapter({
      projectId: 'imp-cid',
      projectSecret: 'imp-sec',
      cernereBaseUrl: baseUrl,
      saPublicBaseUrl: 'ws://127.0.0.1:{port}',
      accept: { memoria: ['events.emit', 'ping'] },
    });
    let lastEvent = null;
    imperativus.handle('events.emit', async (_caller, p) => {
      lastEvent = p;
      return { ok: true };
    });
    imperativus.handle('ping', async (_c, p) => ({ ok: true, echo: p }));
    await imperativus.start();
    imperativus.__lastEvent = () => lastEvent;

    // Configure env vars consumed by Memoria's cernere.js, then start it.
    process.env.CERNERE_PROJECT_ID = 'memoria-cid';
    process.env.CERNERE_PROJECT_SECRET = 'memoria-sec';
    process.env.CERNERE_BASE_URL = baseUrl;
    process.env.MEMORIA_HOOK_TARGET = 'imperativus';

    memoriaModule = await import('../cernere.js');
    await memoriaModule.startCernere({
      upsertUser: async () => {},
      revokeUser: async () => {},
      peerHandlers: {
        'memoria.list_categories': async () => ({ items: [{ category: 'demo', count: 1 }] }),
        'memoria.search': async (_caller, p) => ({ items: [], echoed_query: p?.query ?? '' }),
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (memoriaModule) await memoriaModule.stopCernere().catch(() => {});
    if (imperativus) await imperativus.stop().catch(() => {});
    if (cernere) await cernere.stop().catch(() => {});
    delete process.env.CERNERE_PROJECT_ID;
    delete process.env.CERNERE_PROJECT_SECRET;
    delete process.env.CERNERE_BASE_URL;
    delete process.env.MEMORIA_HOOK_TARGET;
  });

  it('boots Memoria peer adapter via Cernere admission', async () => {
    const peer = memoriaModule.getPeerAdapter();
    expect(peer).toBeTruthy();
    expect(typeof peer.boundListenPort).toBe('number');
  });

  it('responds to imperativus.invoke(memoria.list_categories)', async () => {
    const r = await imperativus.invoke('memoria', 'memoria.list_categories', {});
    expect(r).toEqual({ items: [{ category: 'demo', count: 1 }] });
  });

  it('echoes search query back', async () => {
    const r = await imperativus.invoke('memoria', 'memoria.search', { query: 'hello world' });
    expect(r).toEqual({ items: [], echoed_query: 'hello world' });
  });

  it('emitEvent reaches the configured hook target', async () => {
    await memoriaModule.emitEvent('memoria.bookmark.saved', {
      userId: 'alice',
      payload: { id: 1, url: 'https://example.com', title: 'x' },
    });
    // Allow a short tick for the WS round-trip.
    await new Promise((r) => setTimeout(r, 100));
    const last = imperativus.__lastEvent();
    expect(last).toBeTruthy();
    expect(last.source).toBe('memoria');
    expect(last.event).toBe('memoria.bookmark.saved');
    expect(last.user_id).toBe('alice');
    expect(last.payload).toEqual({ id: 1, url: 'https://example.com', title: 'x' });
  });
});
