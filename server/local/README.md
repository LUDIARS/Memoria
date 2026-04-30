# `server/local/` — Local-only features

Everything that the multi server (Memoria Hub) does **not** ship lives here.
These features assume a single user and a single SQLite database file —
i.e. they do not need to think about `owner_user_id`.

| feature | module |
| --- | --- |
| Visit history (`page_visits` / `visit_events`) | `local/visits.js` |
| Daily diary + weekly report | `local/diary.js` |
| Domain catalogue | `local/domain-catalog.js` |
| Per-page metadata (og:* + Sonnet kind) | `local/page-metadata.js` |
| Uptime + downtime tracking | `local/uptime.js` |
| Work queue + queue history | `local/queue.js` (TODO) |
| GitHub commits → diary | `local/github.js` (TODO) |
| Recommendations (未訪問リンク) | `local/recommendations.js` |

## Phase 0 placement

As with [`../core/`](../core/README.md), the actual implementations are
still at `server/*.js` to keep the CI smoke test green. They migrate here
in a follow-up cleanup PR. Until then this directory holds READMEs and
new modules.

The DB layer is shared with `core/` via [`../db/`](../db/README.md). All
local-only tables (`page_visits`, `domain_catalog`, `diary_entries`,
`server_events`, etc.) live in the SQLite adapter.
