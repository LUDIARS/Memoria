// SQLite adapter for the local server.
//
// Phase 0 implementation: re-export the legacy monolithic `server/db.js`
// so call sites can migrate one at a time. When Phase 2 adds a Postgres
// adapter, both will sit behind `./index.js`.
export * from '../db.js';
export { openDb as default } from '../db.js';
