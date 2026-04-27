# Module: Cernere Bridge

`@ludiars/cernere-service-adapter` の admission + peer adapter を Memoria プロセスに統合する薄い層。

## 目的
- Cernere の admission flow と LUDIARS 内 peer 通信に Memoria を参加させる
- SDK が無くても (`optionalDependencies`、CI 等) Memoria が動き続けるように lazy import + fail-soft

## ファイル
`service/cernere.js`

## 起動シーケンス (`startCernere(ctx)`)

1. `import('@ludiars/cernere-service-adapter')` を try/catch — 失敗で `[memoria-cernere] not installed` ログ後に `{admission: false, peer: false}` を返す
2. **Admission**: `CERNERE_WS_URL` + `CERNERE_SERVICE_CODE` + `CERNERE_SERVICE_SECRET` 全てそろっていれば `CernereServiceAdapter` を起動、`onUserAdmission` / `onUserRevoke` を Memoria DB と紐付け
3. **Peer**: `CERNERE_PROJECT_ID` + `CERNERE_PROJECT_SECRET` + `CERNERE_BASE_URL` が揃っていれば `PeerAdapter` を起動、`accept` allowlist と `peerHandlers` を渡す
4. `MEMORIA_HOOK_TARGET` (例: `imperativus`) を `eventTarget` に格納
5. `SIGINT/SIGTERM` で `stopCernere()` を呼ぶ (peer.stop + admission.disconnect)

## peer accept (デフォルト)

```jsonc
{
  "imperativus": [
    "memoria.search",
    "memoria.save_url",
    "memoria.list_categories",
    "memoria.recent_bookmarks",
    "memoria.get_bookmark",
    "memoria.dig",
    "memoria.unsaved_visits",
    "ping"
  ]
}
```

これに加えて Cernere 側 `relay_pairs` テーブルで `(memoria, imperativus)` の bidirectional pair が必要。

## peer handlers (実装は `service/index.js` の `buildPeerHandlers()`)

すべて payload の `user_id` を必須とする (server-to-server で送信元が認証情報を持つ前提)。

| Command | 入力 | 出力 |
|---------|------|------|
| `memoria.search` | `{user_id, query, limit?}` | `{items: BookmarkRow[]}` |
| `memoria.save_url` | `{user_id, url}` | `{status: queued/duplicate/blocked, id?, ...}` (Memoria が server-side fetch) |
| `memoria.save_html` | `{user_id, url, title, html}` | `{id, queued: true / duplicate: true}` (Imperativus が拡張から受け取った HTML を中継する primary パス) |
| `memoria.list_categories` | `{}` | `{items: [{category, count}]}` |
| `memoria.recent_bookmarks` | `{user_id, limit?}` | `{items: BookmarkRow[]}` |
| `memoria.get_bookmark` | `{user_id, id}` | `BookmarkRow` |
| `memoria.dig` | `{user_id, query}` | `{id, queued: true}` |
| `memoria.unsaved_visits` | `{days?}` | `{items: VisitRow[]}` (online で throws) |
| `ping` | `{...}` | `{ok, from, echo, ts}` |

### Imperativus 経由の HTTP relay

`POST /api/relay/memoria/save_html` (Imperativus 側) から呼ばれた場合の流れ:

```
[拡張]
  ↓ POST <imperativus>/api/relay/memoria/save_html
  ↓ Authorization: Bearer <Cernere service_token>
  ↓ body: { url, title, html }
[Imperativus PeerRelayAPI]
  - JWT 検証 → user_id 確定
  - allowlist (memoria.* のうち save_html を許可)
  - rate limit 60/min × user × command
  - peer.invoke('memoria', 'memoria.save_html', { url, title, html, user_id })
[Memoria peer handler]
  - saveBookmarkFromHtml({...}) を呼ぶ
  - NG フィルタ → 重複チェック → 要約キュー投入
  - emitEvent(memoria.bookmark.saved)
```

online モードで `POST /api/bookmark` の HTTP 直叩きは **410 Gone** で拒否されるため、relay 以外のルートで書込まれることはない。

## emitEvent (`service/cernere.js`)

```js
emitEvent('memoria.bookmark.saved', { userId, payload: {...} })
→ peer.invoke(eventTarget, 'events.emit', {
    source: 'memoria',
    event: 'memoria.bookmark.saved',
    user_id: userId,
    payload: {...},
    ts: Date.now(),
  })
```

ターゲットや peer adapter が無いときは `{delivered: false}` を返して終わる (fail-soft)。

## 発行イベント

| Event | 発火タイミング | payload |
|-------|--------------|---------|
| `memoria.bookmark.saved` | `/api/bookmark` で新規保存成功 | `{id, url, title}` |
| `memoria.summary.done` | claude 要約 + カテゴリ完了 | `{id, url, title, summary, categories}` |
| `memoria.dig.completed` | ディグるセッション完了 | `{session_id, query, source_count}` |
| `memoria.recommendation.created` | (将来) 関連サイト推薦の新規追加 | `{url, score, source_count}` |

## auth との連携

- `CernereServiceAdapter.isRevoked(userId)` が true なら HTTP middleware が 401 を返す
- service_token は SDK 内で Memoria の `MEMORIA_JWT_SECRET` (= Cernere `SERVICE_JWT_SECRET`) 署名で発行されるので、Memoria 側の HS256 verifier がそのまま検証可能

## 環境変数

| 変数 | 必須 | 用途 |
|------|------|------|
| `CERNERE_WS_URL` | admission | `ws://cernere:8080/ws/service` |
| `CERNERE_SERVICE_CODE` | admission | `memoria` |
| `CERNERE_SERVICE_SECRET` | admission | Cernere admin が rotate-secret で取得 |
| `CERNERE_PROJECT_ID` | peer | `managed_projects.client_id` |
| `CERNERE_PROJECT_SECRET` | peer | `managed_projects.client_secret` (rotate で取得) |
| `CERNERE_BASE_URL` | peer | `http://cernere:8080` |
| `MEMORIA_SA_HOST` / `_PORT` / `_PUBLIC_URL` | peer | adapter listen 設定 (省略可) |
| `MEMORIA_HOOK_TARGET` | events | `imperativus` (空なら emitEvent は no-op) |

## 関連リソース

- [@ludiars/cernere-service-adapter README](https://github.com/LUDIARS/Cernere/tree/main/packages/service-adapter)
- [LUDIARS/Memoria spec/events.md](../../events.md)
- [LUDIARS/Imperativus event_hooks](https://github.com/LUDIARS/Imperativus/tree/main/src/event-hooks)

## ロードマップ

- FakeCernere ベースの integration test
- admission flow をフロント (拡張) からトリガーするフロー (現在は手動 token 設定)
- Imperativus 側 event_hooks の管理 UI と双方向連携
