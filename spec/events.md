# Memoria — Peer Adapter Events & Commands

Memoria が `@ludiars/cernere-service-adapter` の `PeerAdapter` 経由で公開する API と、Memoria 側から発行するイベントの一覧。

接続確立は Cernere の challenge プロトコルに従う ([Cernere Service Adapter README](https://github.com/LUDIARS/Cernere/blob/main/packages/service-adapter/README.md))。
データ経路は Cernere に介在せず、Memoria↔他サービス間で直接 WebSocket を維持する。

---

## 1. Memoria が受信するコマンド (peer.handle)

呼び出し側 (Imperativus 等) は `peerAdapter.invoke("memoria", "<command>", payload)` で叩く。
ペイロードには **必ず `user_id`** を含めること (peer 通信は server-to-server なので、呼び出し元ですでにユーザー特定済み前提)。

| Command | 入力 | 出力 |
|---------|------|------|
| `memoria.search` | `{ user_id, query, limit? }` | `{ items: BookmarkRow[] }` (タイトル/URL/要約/メモを substring 検索) |
| `memoria.save_url` | `{ user_id, url }` | `{ status: 'queued' / 'duplicate' / 'blocked', id?, reason?, matches? }` (HTML を fetch して保存、要約キュー投入。NG ワードは `blocked`) |
| `memoria.list_categories` | `{}` | `{ items: [{ category, count }] }` |
| `memoria.recent_bookmarks` | `{ user_id, limit? }` | `{ items: BookmarkRow[] }` |
| `memoria.get_bookmark` | `{ user_id, id }` | `BookmarkRow` |
| `memoria.dig` | `{ user_id, query }` | `{ id, queued: true }` (完了時に `memoria.dig.completed` を発火) |
| `memoria.unsaved_visits` | `{ days? }` | `{ items: VisitRow[] }` (※ online モードでは throws) |
| `ping` | `{ ... any }` | `{ ok: true, from, echo, ts }` (疎通確認) |

`accept` リストはデフォルトで `imperativus` のみ許可。`MEMORIA_SA_ACCEPT_*` 環境変数 (今後追加予定) で柔軟に変更可。

---

## 2. Memoria が発行するイベント (peer.invoke target)

Memoria は事象が発生したら `MEMORIA_HOOK_TARGET` に指定された peer (例: `imperativus`) に対して `events.emit` を invoke する。
受信側は **per-user の event hook 設定** に従ってリレー先を決定する責任を持つ (Imperativus 仕様)。

イベントペイロードの統一形式:

```json
{
  "source": "memoria",
  "event": "<event_name>",
  "user_id": "<sub from JWT>",
  "payload": { /* event-specific */ },
  "ts": 1700000000000
}
```

| Event | 発火タイミング | payload |
|-------|--------------|---------|
| `memoria.bookmark.saved` | `/api/bookmark` 成功時 (重複でない新規保存) | `{ id, url, title }` |
| `memoria.summary.done` | claude による要約 + カテゴリ生成完了 | `{ id, url, title, summary, categories }` |
| `memoria.dig.completed` | ディグるセッション完了 | `{ session_id, query, source_count }` |
| `memoria.recommendation.created` | (将来) 関連サイト推薦が新規生成された時 | `{ url, score, source_count }` |

---

## 3. Imperativus 側に実装が必要なエンドポイント

Imperativus が Memoria からのイベントを受け取るためには、PeerAdapter で次の handler を提供する想定:

```typescript
peer.handle('events.emit', async (caller, msg) => {
  // caller.projectKey === 'memoria' を確認
  // msg.event のフックが user_id に対して設定されているかチェック
  // 設定されていればルーティングして実行
  return { ok: true };
});
```

Imperativus 側で:

- ユーザーごとに `event_hooks(user_id, source, event_pattern, target_action)` を保存
- 受信した event_name にマッチするフックを検索 → 各 target_action を発火
  - target_action 例: 「Slack に通知」「カレンダーに予定追加 (Actio へ peer.invoke)」「ボイスで読み上げ」

---

## 4. 接続図

```
                       ┌──────────────────────────────────┐
                       │            Cernere               │
                       │  (managed_projects, challenge)   │
                       └──────────────────────────────────┘
                            │  peer establish via WS
                            │  (Cernere challenge → WS direct)
                            ▼
        ┌─────────────────────────────────────────────────────┐
        │                                                     │
        ▼                                                     ▼
┌─────────────────┐    invoke memoria.*         ┌─────────────────┐
│   Imperativus   │ ─────────────────────────►  │     Memoria     │
│   (per-user     │                             │   (peer adapter │
│   event hooks)  │ ◄─────────────────────────  │   + admission)  │
└─────────────────┘    invoke events.emit       └─────────────────┘
        ▲                  (memoria.*)
        │
        │ Chrome 拡張 / Web UI
        │ (HTTP + service_token)
        │
   [ End user ]
```
