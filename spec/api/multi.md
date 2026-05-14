# multi — Memoria Hub 連携 API

> ⚠ **このページは旧設計 (OAuth-dance / share-relay 方式) の API 契約。**
> Local / Multi 二層化の再設計が進行中 — 新しい設計とエンドポイント仕様は
> [`spec/feature/multi-hub.md`](../feature/multi-hub.md) を参照。 実装フェーズ
> ごとに本ページを新契約へ更新していく。

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
