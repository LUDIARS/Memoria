// Compatibility shim for the legacy monolithic `server/db.js`.
//
// The DAO functions used to live in this file as one ~2000-line module. They
// have been split into domain-specific files under `server/db/`. This file
// re-exports the entire surface so existing callers (`from './db.js'`,
// `from '../db.js'`, etc.) keep working unchanged.
//
// New code should prefer importing from the specific domain module
// (e.g. `from './db/bookmarks.js'`) or from the adapter façade
// (`from './db/index.js'`) so it doesn't pull the full surface.

export { openDb } from './db/schema.js';
export * from './db/_helpers.js';
export * from './db/push.js';
export * from './db/bookmarks.js';
export * from './db/visits.js';
export * from './db/dig.js';
export * from './db/sharing.js';
export * from './db/settings.js';
export * from './db/wordcloud.js';
export * from './db/dictionary.js';
export * from './db/page-metadata.js';
export * from './db/domain-catalog.js';
export * from './db/server-events.js';
export * from './db/diary.js';
export * from './db/trends.js';
export * from './db/gps.js';
export * from './db/meals.js';
