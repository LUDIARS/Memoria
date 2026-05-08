# multi — Memoria Hub 連携 API

ローカルから `multi/` (Hub) を proxy + 認証 + share/download するための API。

## 接続管理

| method | path | req | res |
|---|---|---|---|
| GET | `/api/multi/status` | — | `MultiStatusResponse` |
| POST | `/api/multi/servers` | `{ url, label? }` | `{ ok, servers }` |
| DELETE | `/api/multi/servers` | `{ url }` | `{ ok, servers }` |
| POST | `/api/multi/active` | `{ urls: string[] }` | `{ ok, active }` |
| POST | `/api/multi/connect` | `{ url }` | `{ redirect_url }` |
| POST | `/api/multi/finish` | `{ url, code, state }` | `{ ok, user }` |
| POST | `/api/multi/disconnect` | `{ url? }` | `{ ok }` |

## proxy (Hub への passthrough)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/multi/proxy/*` | — | Hub からそのまま |
| POST | `/api/multi/proxy/*` | (moderation のみ許可) | Hub からそのまま |

## share / download

| method | path | req | res |
|---|---|---|---|
| POST | `/api/multi/share` | `{ kind, id }` | `{ ok, remote }` |
| POST | `/api/multi/download` | `{ kind, remote_id }` | `{ ok, id, owner? }` |

`kind` は `'bookmark' \| 'dig' \| 'dict' \| 'implementation_note' \| 'work_location'`。
