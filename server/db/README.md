# `server/db/` — Database abstraction seam

Phase 0 introduces this folder as the seam where the **SQLite** local-server
backend and the future **Postgres** multi-server backend will live side by
side. Until Phase 2 lands a Postgres adapter, only `sqlite.js` is real.

```
db/
├── index.js   ← façade: picks an adapter (SQLite default), re-exports the
│                same surface that the old monolithic `server/db.js` did.
├── sqlite.js  ← thin wrapper around `../db.js` (the current 1000+ line
│                better-sqlite3 module). Phase 0 keeps the implementation
│                in place to keep the smoke test green.
└── postgres.js (Phase 2) ← Cernere-fronted multi-server adapter.
```

## Why a façade rather than a hard move

The legacy `server/db.js` has hundreds of named exports consumed by
`index.js`, `diary.js`, `dig.js`, etc. Renaming every import in one PR risks
silent breakage (CI smoke does a `node --check`, not a full run of every
endpoint). The façade lets us:

1. Move call sites to `from './db/index.js'` incrementally per module.
2. Plug a Postgres adapter for the multi server without touching local code.
3. Keep the legacy `server/db.js` import path working until every caller has
   migrated.

## Selecting an adapter

`openDb(dbPath, { kind } = {})` accepts:

- `kind: 'sqlite'` (default) — the current implementation.
- `kind: 'postgres'` (Phase 2) — opens a connection pool against the URL in
  `MEMORIA_PG_URL`. `dbPath` is ignored.

The Multi server boots with `MEMORIA_MODE=multi` (Phase 7) and sets the
adapter at startup; everything else stays adapter-agnostic.
