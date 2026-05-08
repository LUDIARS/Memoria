# chat — 外部チャット取り込み

## `external_chat_messages`
Discord / Slack / 手動コピペなど、 外部チャットからの抜粋をログ。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `source` | TEXT | ✓ | — | `discord` / `slack` / `manual` 等 |
| `conversation_id` | TEXT |  | NULL | 同じ会話の messages を束ねる |
| `role` | TEXT |  | NULL | `user` / `assistant` / `system` 等 |
| `content` | TEXT | ✓ | — | 本文 |
| `metadata_json` | TEXT |  | NULL | チャネル名 / URL 等 (JSON) |
| `received_at` | TEXT | ✓ | UTC | |

Index: `idx_external_chat_received` / `idx_external_chat_source`
