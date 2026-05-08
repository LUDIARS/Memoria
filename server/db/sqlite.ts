// SQLite adapter for the local server.
//
// Phase 0 implementation: re-export the legacy monolithic `server/db.ts`
// so call sites can migrate one at a time. When Phase 2 adds a Postgres
// adapter, both will sit behind `./index.ts`.
export * from '../db.js';
export { openDb as default } from '../db.js';
