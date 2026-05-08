// Database façade.
//
// Picks an adapter at runtime so the rest of the server can stay agnostic.
// Default is SQLite (local server). Phase 2 will register a Postgres
// adapter for the multi server (Memoria Hub).
import * as sqlite from './sqlite.js';

const ADAPTER = (process.env.MEMORIA_DB_KIND || 'sqlite').toLowerCase();

function pickAdapter(kind: string): typeof sqlite {
  switch (kind) {
    case 'sqlite':
      return sqlite;
    case 'postgres':
      throw new Error('postgres adapter is not yet implemented (Phase 2)');
    default:
      throw new Error(`unknown MEMORIA_DB_KIND: ${kind}`);
  }
}

const adapter = pickAdapter(ADAPTER);

// Re-export the adapter's full surface so importers can `import { … } from
// 'server/db/index.js'` without caring which backend is active.
export const openDb = adapter.openDb;
export * from './sqlite.js';
