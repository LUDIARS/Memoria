# hub-sync — 認証 / 同期 / ソース選択の API 契約

> 設計: [`../feature/hub-sync.md`](../feature/hub-sync.md) / schema: [`../data/hub-sync.md`](../data/hub-sync.md)
> 既存の Hub CRUD (`/api/data/<type>`) は [`multi.md`](./multi.md) が正本。 **変更しない**。

## 0. 共通

- ローカル側 (`:5180`) の `/api/auth/cernere/*` は **loopback 限定**。 非 loopback は
  `403 { error: 'loopback_only' }` (端末登録を外から奪われないため)
- Hub 側の新 endpoint は既存と同じく **project-token** (Bearer) 認証
- 時刻は UTC ISO 8601。 rev は整数
- エラーは `{ error, detail? }`

## 1. ローカル: Cernere 認証口

| method | path | req | res |
|---|---|---|---|
| GET | `/api/auth/cernere/status` | — | `{ linked, state, user?, accessExpiresAt?, lastRefreshAt?, lastError? }` |
| POST | `/api/auth/cernere/link/begin` | `{ cernereUrl }` | `{ url, qrDataUrl, expiresAt }` |
| POST | `/api/auth/cernere/link/complete` | `{ authCode }` | `{ ok, user }` |
| POST | `/api/auth/cernere/refresh` | — | `{ ok, accessExpiresAt }` |
| DELETE | `/api/auth/cernere/link` | — | `{ ok }` |

`state` は `unlinked` / `linked` / `degraded` の 3 値
([feature §3](../feature/hub-sync.md#3-要件-2-自動ログイン))。

- `degraded` = 資格情報は生きているがネットワーク等で更新できていない。
  **同期は止まるが UI は「未接続」 を表示して古いデータと区別する**
- `unlinked` に落ちたら再登録を要求する。 黙って local-only 動作に落とさない
- `link/begin` は Cernere の device-link を呼ぶだけ。 **token 本体はレスポンスに出さない**
  (URL の中にしか現れない)

## 2. Hub: 変更ログと初回スナップショット

| method | path | req | res |
|---|---|---|---|
| GET | `/api/data/changes?since=&limit=` | — | `{ changes: Change[], nextSince, headRev }` |
| GET | `/api/data/snapshot?type=&cursor=&limit=` | — | `{ items, nextCursor, snapshotRev }` |
| GET | `/api/data/<type>?ids=a,b,c` | — | `{ items }` (差分で拾った id をまとめ取り) |

```jsonc
// Change
{ "rev": 10241, "type": "bookmarks", "id": "3391", "op": "upsert" }
```

- `limit` は既定 500 / 最大 1000 (`changes`)、 既定 200 / 最大 500 (`snapshot`)
- `changes` は **本体を返さない**。 変更ログを太らせないため、 本体は `?ids=` で取る
- **型フィルタは提供しない**。 カーソルは Hub ごとに 1 本で、 絞り込んだまま `since` を
  進めると他型の変更を取りこぼす ([feature §4.2](../feature/hub-sync.md#42-差分取得))
- `snapshot` は最初の応答で `snapshotRev` を確定し、 以降のページでも同じ値を返す。
  クライアントはページングが終わったら `since = snapshotRev` で差分に移る
  ([feature §4.3](../feature/hub-sync.md#43-初回取得-分割))
- `changes` が返すのは **呼び出しユーザに見えるものだけ** (hidden / 未参加 room は除外)。
  可視性が落ちた行は `op='delete'` として見える (= ローカルから消える)
- `ids=` は 1 回 200 件まで

## 3. ローカル: 同期の制御と可視化

| method | path | req | res |
|---|---|---|---|
| GET | `/api/hubs` | — | `{ items: HubServer[] }` (同期状態込み) |
| POST | `/api/hubs` | `{ url, label, cernereUrl?, projectKey? }` | `201 { hub }` |
| PATCH | `/api/hubs/:id` | `{ label?, syncEnabled?, pushAllowed? }` | `{ hub }` |
| DELETE | `/api/hubs/:id` | `?purge=1` で同期済みデータも削除 | `{ ok, removedRows }` |
| POST | `/api/hubs/:id/sync` | `{ full?: boolean }` | `202 { started }` (手動起動 / `full` で初回からやり直し) |
| GET | `/api/hubs/:id/sync/status` | — | `{ phase, perType: [...], lastError? }` |

```jsonc
// HubServer
{
  "id": 1, "url": "https://hub.example", "label": "本社",
  "syncEnabled": true, "pushAllowed": true,
  "sync": { "phase": "delta", "lastRev": 10241, "lastSyncedAt": "…",
            "initialProgress": { "doneTypes": 8, "totalTypes": 8, "items": 1240 } }
}
```

- `DELETE /api/hubs/:id` は既定で **同期済みデータを残す** (誤操作で他人の議論ごと消さない)。
  消すなら `?purge=1` を明示し、 消えた件数を返す

## 4. ローカル: 表示ソースの選択

既存の一覧系 endpoint (`/api/bookmarks` / `/api/notes` / `/api/ai/articles` …) に
**共通クエリ**を足す。 新しい endpoint は増やさない。

| query | 意味 |
|---|---|
| `source=local` | `source_hub_id IS NULL` (**既定**) |
| `source=hub:<id>` | その Hub から同期した行のみ |
| `source=all` | ローカル + 全 Hub。 canonical key で束ねる |

`source=all` の応答は各行に `sources` を付ける:

```jsonc
{ "id": 3391, "url": "https://example.com/x", "title": "…",
  "sources": [ { "kind": "local" }, { "kind": "hub", "hubId": 1, "label": "本社" } ] }
```

- 束ねるキーは型ごとに定義済み ([feature §5](../feature/hub-sync.md#5-要件-4-表示ソースの選択))
- **束ねても行は消さない**。 同じ URL でも人によってメモが違うため、
  詳細を開けば個別に読める

## 5. ローカル: push (自動化しない)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/hubs/push-targets?type=&id=` | — | `{ targets: [{ hubId, label, alreadyPushed, remoteId? }] }` |
| POST | `/api/hubs/:id/push` | `{ type, localId, options? }` | `{ ok, remoteId }` / `409 { error: 'redaction_blocked', blocked }` |
| POST | `/api/hubs/:id/unshare` | `{ type, localId, mode? }` | `{ ok }` |

- **自動 push の経路は存在しない**。 定期ジョブも「共有済みなら追随」 も作らない
  ([feature §6](../feature/hub-sync.md#6-制約-push-は自動でしない--先を選べる))
- `push-targets` は UI が選択肢を出すためのもの。 **既定選択は返さない**
  (`alreadyPushed` は情報として返すが、 それを既定にはしない)
- `pushAllowed=false` の Hub は `targets` に出さない
- push は既存の型別ゲートを通る (AIノート = 禁止語スキャン必須)
- 成功時に `hub_pushes` へ記録し、 `unshare` の対象を特定できるようにする

## 6. 既存 API への影響

| 既存 | 影響 |
|---|---|
| `/api/data/<type>` (Hub) | 変更なし。 `?ids=` を追加するのみ |
| `/api/multi/mode` / `/api/multi/login` (ローカル) | Phase 6 まで**残す**。 新経路と併存 |
| `/api/multi/proxy/*` | Phase 6 で撤去 |
| 一覧系 endpoint | `source=` クエリを追加。 未指定は従来どおり (= ローカルのみ) |

`source` 未指定時の挙動を変えないので、 既存クライアント (Chrome 拡張 / desktop) は
無改修で動く。
