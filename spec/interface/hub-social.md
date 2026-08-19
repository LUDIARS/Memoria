# hub-social — 共有サーバ層の API 契約 (social / achievements / dig room)

> 設計の全体像:
> [`spec/feature/hub-social.md`](../feature/hub-social.md) (subject / コメント / いいね / フィード) /
> [`hub-achievements.md`](../feature/hub-achievements.md) (実績) /
> [`hub-dig-rooms.md`](../feature/hub-dig-rooms.md) (共同 dig)。
> schema: [`spec/data/hub-social.md`](../data/hub-social.md)。
> Hub 全体の入口は [`multi.md`](./multi.md)。

## 0. 共通事項

- **Hub 側 endpoint** はすべて Hub session 認証 (multi-hub §5.2 の Bearer token) 必須。
  未認証は `401 { error: 'unauthorized' }`
- **ローカル側 endpoint** は `:5180` 上。 Multi モード時は Hub の対応 endpoint に
  proxy し、 Local モード時は §7 の縮退動作をする
- 既存 `/api/data/*` (7 型 CRUD) の **契約は変更しない**。 本書の endpoint はすべて追加。
  例外は §6.5 の `ai-articles` (8 型目) で、 これも既存 7 型と同じ形の `<type>` 追加のみ
  (既存 7 型の req / res は不変)
- エラー形式は既存 Hub と同じ `{ error, code? }`。 レート超過は
  `429 { error: 'rate_limited', retryAfter }`
- ページングは `?limit=` (既定 50 / 最大 200) + `?cursor=` (opaque。
  `created_at,id` の composite を base64)。 `{ items, nextCursor }` を返す
- 時刻はすべて **UTC ISO 8601 文字列**でやり取りする (DB は TIMESTAMPTZ)

## 1. subject 解決

| method | path | req | res |
|---|---|---|---|
| POST | `/api/social/subjects/resolve` | `{ kind, key, title?, excerpt? }` | `{ subject }` |
| GET | `/api/social/subjects/:id` | — | `{ subject }` |
| GET | `/api/social/subjects?kind=&keys=` | — | `{ items: Subject[] }` (最大 100 key の一括解決) |
| PATCH | `/api/social/subjects/:id` | `{ title?, excerpt? }` | `{ subject }` (moderator のみ) |
| POST | `/api/social/subjects/:id/hide` | `{ reason }` | `{ ok }` (moderator) |

- `resolve` は **get-or-create**。 既に別名 (`subject_aliases`) に一致すれば
  既存 subject を返す
- `key` はクライアントが正規化した値を送る。 サーバ側でも再正規化して
  **一致しなければ `400 { error: 'key_not_canonical', canonical }`** を返す
  (= ローカルとサーバの正規化実装のずれを検出する。 黙って直さない)
- `GET /api/social/subjects?keys=` は一覧画面用。 「この 50 件のブクマにコメントが
  何件あるか」 をまとめて取る

```jsonc
// Subject
{
  "id": "9f1c…", "kind": "bookmark",
  "key": "https://example.com/article",
  "title": "…", "excerpt": "…",
  "commentCount": 4, "likeCount": 7, "participantCount": 3,
  "lastActivityAt": "2026-07-30T02:11:00Z",
  "liked": true,            // 呼び出しユーザが like 済か
  "watching": true
}
```

## 2. コメント

| method | path | req | res |
|---|---|---|---|
| GET | `/api/social/comments?subject=&author=&group=&anchored=` | — | `{ items: Comment[], nextCursor? }` |
| GET | `/api/social/comments/:id` | — | `{ comment }` |
| POST | `/api/social/comments` | `{ subjectId, bodyMd, parentCommentId?, anchor?, renditionId?, originLocalId? }` | `201 { comment }` |
| PATCH | `/api/social/comments/:id` | `{ bodyMd }` | `{ comment }` (作者のみ) |
| DELETE | `/api/social/comments/:id` | — | `{ ok }` (作者 / moderator。 soft delete) |
| POST | `/api/social/comments/:id/hide` | `{ reason }` | `{ ok }` (moderator) |

- `group=author` で「ユーザごとのコメント集合」 (= ローカル `note_comment_sets` 相当) を返す:
  `{ groups: [{ author: { id, name }, comments: Comment[], updatedAt }] }`
- `anchored=1` でアンカー付きのみ / `anchored=0` で subject 全体コメントのみ
- `originLocalId` を送ると **冪等**。 同じ値で二度 POST しても 1 行しかできない
  (`200 { comment, duplicate: true }` を返す)。 ローカル push のリトライ安全性のため
- `parentCommentId` が既に親を持つコメントを指す場合 `400 { error: 'nested_reply' }`
- アンカーが解決できない状態で作成された場合も `201`。 `anchorState: 'orphan'` が入る

```jsonc
// Comment
{
  "id": "3ab…", "subjectId": "9f1c…",
  "author": { "id": "u_1", "name": "…" },
  "parentCommentId": null,
  "bodyMd": "ここの前提が変わってる",
  "anchor": { "target": { "kind": "rendition", "renditionId": "…" },
              "selectors": [ { "type": "TextQuote", "exact": "…", "prefix": "…", "suffix": "…" },
                             { "type": "TextPosition", "start": 1840, "end": 1902 } ] },
  "anchorState": "resolved",
  "likeCount": 2, "liked": false,
  "createdAt": "…", "editedAt": null, "deletedAt": null
}
```

## 3. いいね (reaction)

| method | path | req | res |
|---|---|---|---|
| POST | `/api/social/reactions` | `{ targetKind: 'subject'\|'comment', targetId, kind?: 'like' }` | `201 { ok, count }` |
| DELETE | `/api/social/reactions` | `{ targetKind, targetId, kind?: 'like' }` | `{ ok, count }` |
| GET | `/api/social/reactions?targetKind=&targetId=` | — | `{ items: [{ user, kind, createdAt }], count }` |

- POST は冪等 (既に押していれば `200 { ok, count, already: true }`)
- `kind` の allowlist はサーバ側定数。 v0.1 は `['like']`。 未知値は `400`

## 4. rendition (記事本文)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/social/renditions?subject=` | — | `{ items: Rendition[] }` (`captured_at` 降順) |
| GET | `/api/social/renditions/:id` | — | `{ rendition }` (`textContent` 込み) |
| POST | `/api/social/renditions` | `{ subjectId, textContent, outline?, extractor, capturedAt, htmlContent? }` | `201 { rendition }` |
| POST | `/api/social/renditions/:id/hide` | `{ reason }` | `{ ok }` (moderator) |

- `content_hash` はサーバが計算。 同 subject に同一 hash が既にあれば
  `200 { rendition, duplicate: true }` (新規作成しない)
- `htmlContent` はサーバ設定 `allow_html_rendition=false` のとき **無視して NULL 保存**
  (`{ rendition, htmlIgnored: true }` を返す。 エラーにはしない)
- `textContent` > 1 MiB は `413 { error: 'rendition_too_large' }`

## 5. フィード / 通知 / watch

| method | path | req | res |
|---|---|---|---|
| GET | `/api/feed?sort=&kinds=&tags=&author=&since=&limit=&cursor=` | — | `{ items: FeedItem[], nextCursor? }` |
| GET | `/api/notifications?unread=1&limit=` | — | `{ items, unreadCount }` |
| POST | `/api/notifications/read` | `{ ids?: number[], all?: true }` | `{ ok, unreadCount }` |
| POST | `/api/social/subjects/:id/watch` | — | `{ ok, watching: true }` |
| DELETE | `/api/social/subjects/:id/watch` | — | `{ ok, watching: false }` |
| POST | `/api/social/subjects/:id/mute` | — | `{ ok, muted: true }` |
| DELETE | `/api/social/subjects/:id/mute` | — | `{ ok, muted: false }` |

- `sort` = `active` (既定) / `new` / `liked` / `hot`
- `kinds` はカンマ区切り (`bookmark,note,dig_room`)
- ミュート済 subject はフィードから除外される (直接 GET は可)

```jsonc
// FeedItem
{
  "subject": { /* §1 の Subject */ },
  "latestActivity": { "kind": "comment", "at": "…", "actor": { "id": "u_2", "name": "…" } },
  "participants": [ { "id": "u_1", "name": "…" }, … ],   // 最大 5
  "excerpt": "直近コメントの先頭 120 文字"
}
```

## 6. achievements

### 6.1 Hub 側

| method | path | req | res |
|---|---|---|---|
| GET | `/api/achievements?owner=&repo=&kinds=&from=&to=&rollup=` | — | `{ items: AchievementEntry[], nextCursor? }` |
| POST | `/api/achievements/entries:batch` | `{ entries: AchievementEntryInput[], sharePolicy }` | `{ ok, upserted, skipped, ids }` |
| DELETE | `/api/achievements/entries/:id` | — | `{ ok }` (owner / moderator) |
| GET | `/api/achievements/digests?scopeKind=&scopeKey=&from=&to=&latestOnly=1` | — | `{ items: AchievementDigest[] }` |
| POST | `/api/achievements/digests` | `{ scopeKind, scopeKey, periodStart, periodEnd, summaryMd, highlights?, metrics?, generatedBy }` | `201 { digest }` (`rev` はサーバが決める) |
| GET | `/api/achievements/repos` | — | `{ items: [{ repoKey, repoAlias, entryCount, lastOccurredAt, owners[] }] }` |

- `rollup=pr` (既定) — `parent_ref` を持つ commit を PR 行に畳んで返す。
  `rollup=none` で全件
- `entries:batch` は 1 リクエスト最大 500 件。 UNIQUE `(owner, repo_key, kind, ref)` で
  upsert。 `sharePolicy` は各行の `share_policy` に記録される (監査用)
- `entries:batch` は `redacted` かつ `repoAlias=false` の行を **拒否**する
  (`400 { error: 'alias_required', refs: [...] }`)。 ゲートを Hub 側でも二重に張る

### 6.2 ローカル側

| method | path | req | res |
|---|---|---|---|
| GET | `/api/achievements?...` | — | ローカル `achievement_entries` (共有前の全量) |
| GET | `/api/achievements/sources` | — | `{ items: AchievementSource[] }` |
| POST | `/api/achievements/sources` | `{ sourceKind, repoKey?, localPath?, alias?, sharePolicy?, llmOptout? }` | `201 { source }` |
| PATCH | `/api/achievements/sources/:id` | 同上 (部分) | `{ source }` |
| POST | `/api/achievements/ingest` | `{ sourceIds?: number[], full?: boolean }` | `202 { queued }` |
| POST | `/api/achievements/redaction/check` | `{ sourceIds?: number[] }` | `{ ok, blocked: [{ entryId, field, term }] }` |
| POST | `/api/achievements/push` | `{ sourceIds?: number[], dryRun?: boolean }` | `{ ok, pushed, blocked: [...] }` |
| GET/POST | `/api/achievements/redaction/terms` | `{ term, origin }` | 禁止語辞書の CRUD |
| POST | `/api/achievements/digests` | `{ scopeKind, scopeKey, periodStart, periodEnd, push?: boolean }` | `202 { queued }` (ローカル LLM で生成) |

- `POST /api/achievements/push` は **必ず** redaction スキャンを通る。
  1 件でも block があれば **push 全体を中止**し `409 { error: 'redaction_blocked', blocked }`
- `dryRun=true` で「何が出るか」 の差分だけ返す (push しない)
- `sharePolicy='none'` の source は push 対象から自動除外 (エラーにしない)

## 6.5 AIノート (`ai_articles`) の共有

既存 `/api/data/*` の 8 型目として載るので、 CRUD は
[`multi.md`](./multi.md) / [`../feature/multi-hub.md`](../feature/multi-hub.md) §6.1 の
`<type> = ai-articles` に従う。 本書で追加するのは **共有前のゲート**のみ。

| 側 | method | path | req | res |
|---|---|---|---|---|
| ローカル | POST | `/api/ai/articles/:id/share` | `{ hubUrl?, includeSourceRefs?: boolean }` | `{ ok, remoteId }` / `409 { error: 'redaction_blocked', blocked }` |
| ローカル | POST | `/api/ai/articles/share/check` | `{ ids?: number[] }` | `{ ok, blocked: [{ articleId, field, term }] }` |
| ローカル | POST | `/api/ai/articles/:id/unshare` | — | `{ ok }` (§8.5 の `unshare` に委譲) |
| Hub | POST | `/api/data/ai-articles` | `AiArticleInput` + `{ sharePolicy, redactionScannedAt }` | `201 { item }` |

- ローカルの `share` は **必ず** `server/shared/redaction.ts` を通る
  ([`../feature/hub-achievements.md`](../feature/hub-achievements.md) §4.3 と同一実装)。
  スキャン対象は `title` / `body_md` / `tags` / `source_refs` / `topic_key`
- `includeSourceRefs=true` は、 参照している repo すべての
  `achievement_sources.share_policy` が `full` **と確認できたとき**のみ許可。
  1 つでも違う / `achievement_sources` に行が無い (= 判定できない) 場合は
  `400 { error: 'source_refs_not_shareable', repos: [...] }`。
  既定 (`includeSourceRefs` 省略時) は `false` で `source_refs` を送らない
- `プロジェクト` タグと `topic_key` も repo 名を含みうる。前者は `full` の
  `source_refs` と同じ repo 値だけ、後者は `repo:theme` の repo 部分が同じものだけを送る
- Hub 側は `redactionScannedAt` が無い / 古い (> 24h) POST を
  `400 { error: 'redaction_scan_required' }` で拒否する
- 転写済 (`note_id` あり) の記事を share すると、 Hub は `note_subject_id` を埋め
  `subject_aliases` に `ai_article` → `note` subject の別名を張る
  ([feature §1.2](../feature/hub-social.md#12-aiノート共有で追加が要るもの))
- `ai_article_seeds` / `ai_advice` に共有 endpoint は **作らない** (local-only)

## 7. dig room

### 7.1 部屋

| method | path | req | res |
|---|---|---|---|
| GET | `/api/dig-rooms?state=&theme=&mine=1` | — | `{ items: DigRoom[], nextCursor? }` |
| POST | `/api/dig-rooms` | `{ title, question, theme?, llmPolicy? }` | `201 { room }` |
| GET | `/api/dig-rooms/:id` | — | `{ room, members, digest, board }` |
| PATCH | `/api/dig-rooms/:id` | `{ title?, question?, state? }` | `{ room }` (作成者 / moderator) |
| POST | `/api/dig-rooms/:id/join` | — | `{ ok, member }` |
| DELETE | `/api/dig-rooms/:id/join` | — | `{ ok }` (leave) |

`GET /api/dig-rooms/:id` の `board` が「無駄打ちを消す」 ためのブロック:

```jsonc
"board": {
  "sources":       [ { "contributionId": "…", "url": "…", "title": "…", "quality": "primary", "by": {…}, "at": "…" } ],
  "queries":       [ { "query": "…", "engine": "duckduckgo", "by": {…}, "at": "…", "hitCount": 12 } ],
  "deadEnds":      [ { "text": "…", "by": {…} } ],
  "openQuestions": [ { "contributionId": "…", "text": "…", "by": {…} } ],
  "unreadSeq":     142        // 自分の last_seen_at 以降の contribution 数
}
```

### 7.2 contribution

| method | path | req | res |
|---|---|---|---|
| GET | `/api/dig-rooms/:id/contributions?sinceSeq=&kinds=` | — | `{ items, maxSeq }` |
| POST | `/api/dig-rooms/:id/contributions` | `{ kind, payload, targetContributionId? }` | `201 { contribution }` |
| POST | `/api/dig-rooms/:id/seen` | `{ seq }` | `{ ok }` (`last_seen_at` 更新) |

- `kind='source'` で既出 URL → `409 { error: 'duplicate_source', existing: { contributionId, by, at } }`
- `kind='query'` で既出クエリと Jaccard ≥ 0.8 → `201 { contribution, warning: 'similar_query', similar: [...] }`
  (通す。 止めない)
- `kind='finding'` で `payload.sourceRefs` が空 → `400 { error: 'finding_requires_sources' }`
- **UPDATE / DELETE は無い**。 取り消しは `kind='retract'` + `targetContributionId`

### 7.3 digest と job

| method | path | req | res |
|---|---|---|---|
| GET | `/api/dig-rooms/:id/digests` | — | `{ items: DigRoomDigest[] }` (rev 降順) |
| POST | `/api/dig-rooms/:id/digests` | — | `202 { jobId }` (**生成はしない。 job を作るだけ**) |
| GET | `/api/dig-rooms/jobs?state=queued` | — | `{ items: Job[] }` (自分がメンバーの room のみ) |
| POST | `/api/dig-rooms/jobs/:jid/claim` | — | `{ job, input }` / `409 { error: 'already_claimed' }` |
| POST | `/api/dig-rooms/jobs/:jid/complete` | `{ summaryMd, sources?, openQuestions?, deadEnds?, metrics?, coveredSeq, generatedBy }` | `201 { digest }` |
| POST | `/api/dig-rooms/jobs/:jid/fail` | `{ error }` | `{ ok, willRetry }` |
| POST | `/api/dig-rooms/jobs/:jid/heartbeat` | — | `{ ok, leaseExpiresAt }` (lease 延長) |

- `claim` は `UPDATE ... WHERE state='queued' ... RETURNING` の 1 文で行い、
  同時 claim は 1 人だけ成功する
- `claim` の `input` に `fromSeq` 以降の contribution 全量 + 現行 digest が入る
  (claim したローカルはそれを LLM に渡すだけでよい)
- lease は 5 分。 `heartbeat` を打たないと `queued` に戻る。 3 回失敗で `failed`
- room の `llm_policy` に反する claim は `403 { error: 'llm_policy_denied' }`

### 7.4 ローカル側

| method | path | req | res |
|---|---|---|---|
| POST | `/api/dig/:id/to-room` | `{ roomId? , title?, question? }` | `{ room, contribution }` (room 未指定なら新規作成 + `dig_import`) |
| POST | `/api/dig-rooms/:id/import-local` | — | `{ digSessionId }` (最新 digest をローカル `dig_sessions` に落とす) |
| POST | `/api/dig-rooms/:id/save-sources` | `{ contributionIds?: string[] }` | `{ savedBookmarkIds }` (source を自分のブクマに) |
| GET | `/api/dig-rooms/worker/status` | — | `{ enabled, lastPollAt, claimed, completed, failed }` |

## 8. Local モードでの縮退動作

| endpoint | Local モードでの挙動 |
|---|---|
| `/api/social/subjects/resolve` | 接続済 Hub があれば **その Hub に問い合わせて件数だけ返す** (60 秒メモリキャッシュ)。 無ければ `{ subject: null }` |
| `/api/social/comments` (GET) | ノートは自分のローカル `note_comments` を Comment 形に写して返す。 他 kind は `503 { error: 'local_only' }` |
| `/api/social/comments` (POST) | ノートはローカル `note_comments` に書く (`remote_id=null`)。 他 kind は `503` |
| `/api/social/reactions` | `503 { error: 'local_only' }` |
| `/api/feed` / `/api/notifications` | `503 { error: 'local_only' }` |
| `/api/achievements*` (ローカル分) | **通常動作** (取り込み・一覧・digest はローカルだけで完結する) |
| `/api/achievements/push` | 接続済 Hub が無ければ `503 { error: 'no_hub' }` |
| `/api/dig-rooms*` | `503 { error: 'local_only' }` (room は Hub 上のもの) |

## 8.5 公開の取り下げ (unshare)

[feature §8.1](../feature/hub-social.md#81-公開の取り下げ-unshare) の 3 段階。

| method | path | req | res |
|---|---|---|---|
| POST | `/api/social/unshare` | `{ targetKind, targetId, mode: 'hide'\|'unshare'\|'purge', reason? }` | `{ ok, mode, cascadeCounts? }` |
| POST | `/api/social/unshare/restore` | `{ targetKind, targetId }` | `{ ok }` (`hide` の解除のみ。 `unshare` / `purge` は復元不可) |
| GET | `/api/social/unshares?since=&mine=1` | — | `{ items: UnshareRecord[] }` (ローカルの `shared_at` 同期用) |
| GET | `/api/social/admin/unshare-audit?limit=&targetKind=` | — | `{ items }` (moderator 以上) |

- 権限: `hide` / `unshare` は **対象の持ち主本人 または moderator**、
  `purge` は **admin のみ**。 不足時は `403 { error: 'forbidden', required: 'admin' }`
- `mode='purge'` は破壊的なので `?confirm=<subjectKey>` を必須にする。
  一致しなければ `400 { error: 'confirm_mismatch' }`
- `unshare` の対象が共有 8 型 (既存 7 型 + `ai-articles`) の行のときは Hub 行を削除し、
  レスポンスに `{ localHint: { table, ownerRowKey } }` を返す。 ローカルは
  それを見て自分の `shared_at` / `shared_origin` を NULL に戻す
- `purge` のレスポンス `cascadeCounts` は消えた件数
  (`{ comments, reactions, renditions }`)。 `unshare_audit` にも同じ値が残る
- `GET /api/social/unshares?mine=1` はローカルの定期同期が使う。
  `since` は前回取得時刻 (`unshare_audit.created_at`)

## 9. レート制限

| endpoint | 制限 |
|---|---|
| `POST /api/social/comments` | 30 / 10 min / user |
| `POST /api/social/reactions` | 300 / 10 min / user |
| `POST /api/social/renditions` | 60 / hour / user |
| `POST /api/achievements/entries:batch` | 20 / hour / user (1 回 500 件まで) |
| `POST /api/dig-rooms/:id/contributions` | 120 / 10 min / user |
| `POST /api/dig-rooms/:id/digests` | 6 / hour / room |
| `GET /api/dig-rooms/jobs` | 120 / hour / user (= 30 秒間隔まで許容) |
| `POST /api/social/unshare` | 60 / hour / user (`purge` は 10 / hour / admin) |

## 10. 管理

| method | path | 権限 | 説明 |
|---|---|---|---|
| GET | `/api/social/admin/members` | admin | `hub_members` 一覧 |
| PATCH | `/api/social/admin/members/:userId` | admin | `{ role?, disabled? }` |
| POST | `/api/social/admin/recount` | admin | 非正規化カウンタの全再計算 |
| GET | `/api/social/admin/url-rules` | member | `url_canonical_rules` 一覧 (ローカルが pull する) |
| PUT | `/api/social/admin/url-rules/:host` | admin | ルール upsert |
| GET | `/api/social/admin/settings` | admin | `{ allowHtmlRendition, maxSharePolicy, digestWorker }` |
| PATCH | `/api/social/admin/settings` | admin | 同上の更新 |
