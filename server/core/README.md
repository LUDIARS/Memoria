# `server/core/` — Shareable resources

The three resource types that can be shared between the local server and the
multi server (Memoria Hub) live here:

- **bookmarks** — fetched HTML, summary, categories, word cloud
- **dig sessions** — deep-research queries with their results
- **dictionary entries** — user-curated terms and definitions

The Multi server only ever serves these three kinds. Anything else (diary,
visit history, domain catalogue, page metadata, uptime tracking, work queue)
belongs in [`server/local/`](../local/README.md).

## Phase 0 placement

The implementation files are still living at `server/*.js` so the smoke test
keeps working. As of Phase 0 this directory is the **target** for the move
in a follow-up cleanup PR — see the import map in
[`docs/multi-server-architecture.md`](../../docs/multi-server-architecture.md).

When the move happens these files migrate here:

| current path | future path |
| --- | --- |
| `server/claude.js` | `server/core/claude.js` |
| `server/dig.js` | `server/core/dig.js` |
| `server/wordcloud.js` | `server/core/wordcloud.js` |
| `server/llm.js` | `server/core/llm.js` |

DB access goes through [`../db/`](../db/README.md) so the Postgres adapter
slots in cleanly under either local or multi mode.
