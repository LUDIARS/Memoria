# hub-social — 共有サーバ層のテーブル定義 (Hub Postgres + ローカル追加分)

> ⚠ 本書は **Hub (`server/multi/`) の Postgres スキーマ**が主。
> `spec/data/` の他ファイル (ローカル SQLite) とは DB が違う。
> ローカル SQLite に足す分は §6 に分けて書く。
>
> 機能側: [`hub-social.md`](../feature/hub-social.md) /
> [`hub-worklog.md`](../feature/hub-worklog.md) /
> [`hub-dig-rooms.md`](../feature/hub-dig-rooms.md)
> API: [`../interface/hub-social.md`](../interface/hub-social.md)

## 0. migration 割り当て

既存: `001_init` / `002_implementation_notes` / `004_work_locations` /
`005_workplace_presence` / `007_data_types`。 本書は以下を新設する。

| migration | 内容 |
|---|---|
| `008_social_core.sql` | `subjects` / `subject_aliases` / `url_canonical_rules` / `comments` / `reactions` / `bookmark_renditions` / `subject_activity` / `subject_watches` / `subject_mutes` / `notifications` / `hub_members` + `bookmarks.url_canonical` 追加 |
| `009_worklog.sql` | `worklog_entries` / `worklog_digests` |
| `010_dig_rooms.sql` | `dig_rooms` / `dig_room_members` / `dig_contributions` / `dig_room_digests` / `dig_room_jobs` |

既存 7 型のテーブルは触らない (`bookmarks` への列追加のみ、 `IF NOT EXISTS` で冪等)。

## 1. subject (話題)

### `subjects`

コメント・いいねが付く先の正規オブジェクト。 **owner を持たない**。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK |
| `kind` | TEXT | ✓ | — | `bookmark` / `note` / `note_block` / `dig_room` / `worklog_entry` / `worklog_digest` / `dictionary_term` |
| `key` | TEXT | ✓ | — | kind ごとの正規キー ([feature §3.1](../feature/hub-social.md#31-subject-種別と-key))。 canonical URL 等の生値 |
| `key_hash` | TEXT | ✓ | — | `sha256(key)` の hex。 UNIQUE index 用 (長い URL 対策) |
| `title` | TEXT |  | NULL | 表示用タイトルのキャッシュ (元オブジェクト由来、 正本ではない) |
| `excerpt` | TEXT |  | NULL | 一覧用の抜粋キャッシュ |
| `comment_count` | INTEGER | ✓ | 0 | トリガ維持 (soft delete 済は数えない) |
| `like_count` | INTEGER | ✓ | 0 | トリガ維持 |
| `participant_count` | INTEGER | ✓ | 0 | コメント or reaction した distinct user 数。 トリガ維持 |
| `first_seen_at` | TIMESTAMPTZ | ✓ | `now()` | subject が作られた時刻 |
| `last_activity_at` | TIMESTAMPTZ | ✓ | `now()` | 最終コメント / reaction 時刻。 フィード並び順 |
| `created_by` | TEXT |  | NULL | 最初に触った user id (情報列) |
| `hidden_at` / `hidden_by` / `hidden_reason` | TIMESTAMPTZ / TEXT / TEXT |  | NULL | moderation (既存 7 型と同形式) |

- UNIQUE: `(kind, key_hash)`
- Index: `idx_subjects_activity` (`last_activity_at DESC`) /
  `idx_subjects_kind_activity` (`kind, last_activity_at DESC`) /
  `idx_subjects_hot` (`like_count DESC`)

### `subject_aliases`

canonical 化ルール変更で key が変わったときの旧 key。 迷子防止。

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `kind` | TEXT | ✓ | |
| `key_hash` | TEXT | ✓ | 旧 key の hash |
| `key` | TEXT | ✓ | 旧 key の生値 |
| `subject_id` | UUID | ✓ | FK → `subjects(id)` ON DELETE CASCADE |
| `created_at` | TIMESTAMPTZ | ✓ | |

PK: `(kind, key_hash)`。 resolve は `subjects` → 無ければ `subject_aliases` の順に引く。

### `url_canonical_rules`

host 単位の正規化上書き ([feature §3.3](../feature/hub-social.md#33-domain-別ルール))。
**Hub 側が正**で、 ローカルは pull してキャッシュする。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `host` | TEXT | ✓ | — | PK。 lowercase。 先頭 `.` でサブドメイン一括 (`.example.com`) |
| `keep_query_json` | JSONB |  | NULL | `string[]` — このキーのみ残す (指定時は除去リストより優先) |
| `drop_query_json` | JSONB |  | NULL | `string[]` — 追加で落とすキー |
| `keep_hash` | BOOLEAN | ✓ | `false` | fragment を保持する |
| `alias_host` | TEXT |  | NULL | この host に寄せる |
| `strip_path_suffix_json` | JSONB |  | NULL | `string[]` — 末尾から落とす path 断片 (`/amp` 等) |
| `note` | TEXT |  | NULL | なぜこのルールが要るか |
| `updated_at` | TIMESTAMPTZ | ✓ | `now()` | ローカルの差分 pull 用 |

### `subject_activity`

フィード / 掘り尽くし度用の日次集計。

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `subject_id` | UUID | ✓ | FK → `subjects(id)` CASCADE |
| `day` | DATE | ✓ | UTC 日 |
| `comment_count` | INTEGER | ✓ | その日のコメント数 |
| `like_count` | INTEGER | ✓ | その日の like 数 |
| `actor_count` | INTEGER | ✓ | その日の distinct actor |

PK: `(subject_id, day)`。 Index: `idx_subject_activity_day` (`day DESC`)

### `subject_watches` / `subject_mutes`

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `subject_id` | UUID | ✓ | FK → `subjects(id)` CASCADE |
| `user_id` | TEXT | ✓ | Cernere user id |
| `created_at` | TIMESTAMPTZ | ✓ | |
| `source` | TEXT | ✓ | (watches のみ) `auto` (コメント/like で自動) / `manual` |

PK: `(subject_id, user_id)` (両テーブル)

## 2. コメント / リアクション

### `comments`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK |
| `subject_id` | UUID | ✓ | — | FK → `subjects(id)` ON DELETE CASCADE |
| `author_user_id` | TEXT | ✓ | — | Cernere user id |
| `author_user_name` | TEXT | ✓ | — | 表示名のスナップショット |
| `parent_comment_id` | UUID |  | NULL | FK → `comments(id)` ON DELETE CASCADE。 **1 段のみ** (親が親を持つ行への insert は拒否) |
| `anchor_json` | JSONB |  | NULL | 本文アンカー ([feature §4.3](../feature/hub-social.md#43-anchor--記事本文--ブロック本文へのコメント))。 NULL = subject 全体 |
| `anchor_state` | TEXT | ✓ | `'none'` | `none` (アンカー無し) / `resolved` / `orphan` |
| `rendition_id` | UUID |  | NULL | FK → `bookmark_renditions(id)`。 どの本文に対して打ったか |
| `body_md` | TEXT | ✓ | `''` | 本文 (markdown、 ≤ 16 KiB)。 soft delete 時は `''` |
| `like_count` | INTEGER | ✓ | 0 | トリガ維持 |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `updated_at` | TIMESTAMPTZ | ✓ | `now()` | 編集で bump |
| `edited_at` | TIMESTAMPTZ |  | NULL | 非 NULL = 編集済 (UI に「編集済」 表示) |
| `deleted_at` | TIMESTAMPTZ |  | NULL | soft delete |
| `deleted_by` | TEXT |  | NULL | 作者 or moderator |
| `origin_local_id` | TEXT |  | NULL | ローカル `note_comments.id` (UUID)。 push 由来の行の重複防止 |
| `shared_origin` | TEXT |  | NULL | どのローカルサーバから来たか (既存 7 型と同じ情報列) |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | moderation |

- Index: `idx_comments_subject_created` (`subject_id, created_at`) /
  `idx_comments_author` (`author_user_id, created_at DESC`) /
  `idx_comments_parent` (`parent_comment_id`) /
  `idx_comments_rendition` (`rendition_id`)
- UNIQUE: `idx_comments_origin` (`origin_local_id`) WHERE `origin_local_id IS NOT NULL`
- CHECK: `parent_comment_id IS NULL OR anchor_json IS NULL` — 返信にアンカーは持たせない
  (アンカーは親が持つ)

> **set 構造は持たない**。 ローカルの `note_comment_sets` 相当は
> `(subject_id, author_user_id)` でのグルーピングで表現する
> ([feature §4.2](../feature/hub-social.md#42-既存-note_comment_sets-との整合))。

### `reactions`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | BIGSERIAL | ✓ | — | PK |
| `target_kind` | TEXT | ✓ | — | `subject` / `comment` |
| `target_id` | UUID | ✓ | — | subject.id or comment.id (多態 FK なので DB 制約は張らず、 トリガで存在確認) |
| `user_id` | TEXT | ✓ | — | |
| `user_name` | TEXT | ✓ | — | 表示名スナップショット |
| `kind` | TEXT | ✓ | `'like'` | v0.1 は `like` のみ。 アプリ側 allowlist で制限 |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |

- UNIQUE: `(target_kind, target_id, user_id, kind)`
- Index: `idx_reactions_target` (`target_kind, target_id`) /
  `idx_reactions_user` (`user_id, created_at DESC`)

### カウンタ維持トリガ

`comments` / `reactions` の INSERT / UPDATE(`deleted_at`) / DELETE で:

- `subjects.comment_count` / `like_count` / `participant_count` / `last_activity_at`
- `comments.like_count`
- `subject_activity` の該当日行を upsert

を更新する。 **アプリ側でのインクリメントは禁止** (二重計上・欠落が出る)。
整合確認用に全再計算 SQL を `009` 以降とは別の `sql/recount_social.sql` に置き、
`POST /api/social/admin/recount` から実行する。

## 3. 記事本文 (rendition)

### `bookmark_renditions`

全員が「同じ本文」 を見るための content-addressed スナップショット
([feature §4.4](../feature/hub-social.md#44-記事本文の共有-rendition))。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK |
| `subject_id` | UUID | ✓ | — | FK → `subjects(id)` CASCADE (kind=`bookmark`) |
| `content_hash` | TEXT | ✓ | — | `sha256(text_content)` hex。 同一本文の重複保存を防ぐ |
| `text_content` | TEXT | ✓ | — | 抽出本文 (≤ 1 MiB)。 アンカー解決の対象 |
| `outline_json` | JSONB |  | NULL | 見出し構造 `[{ level, text, offset }]` |
| `html_content` | TEXT |  | NULL | **opt-in のみ** (案 C)。 サーバ設定 `allow_html_rendition=false` で常に NULL |
| `extractor` | TEXT | ✓ | — | 抽出器の識別子 + version (`readability@0.5` 等)。 再現性のため |
| `captured_at` | TIMESTAMPTZ | ✓ | — | 元ページを取得した時刻 |
| `captured_by` | TEXT | ✓ | — | 取得した user id |
| `byte_size` | INTEGER | ✓ | — | 容量管理用 |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | moderation |

- UNIQUE: `(subject_id, content_hash)`
- Index: `idx_renditions_subject` (`subject_id, captured_at DESC`)
- 「最新 rendition」 = 同 subject で `captured_at` 最大の行。 UI の既定表示

## 4. worklog

### `worklog_entries` (Hub)

ローカルから push された、 **共有ポリシー通過済**の行のみ
([feature §4](../feature/hub-worklog.md#4-共有ゲート--漏らさないための機構))。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | BIGSERIAL | ✓ | — | PK (Hub 内部) |
| `repo_key` | TEXT | ✓ | — | `<owner>/<name>` 正規化済。 `redacted` 時は alias 名 |
| `repo_alias` | BOOLEAN | ✓ | `false` | `repo_key` が alias か (= 本名ではない) |
| `provider` | TEXT | ✓ | — | `github` / `git_local` / `activity` / `impl_note` / `manual` (最初に取れた経路。 情報列) |
| `kind` | TEXT | ✓ | — | `commit` / `pr` / `issue` / `review` / `release` / `impl_note` / `manual` |
| `ref` | TEXT | ✓ | — | sha / `pr/123` / tag / note id |
| `parent_ref` | TEXT |  | NULL | 属する PR の ref (畳み込み用) |
| `title` | TEXT | ✓ | — | `redacted` 時は固有名を含まない要約文 |
| `body_md` | TEXT |  | NULL | `redacted` 時は NULL |
| `url` | TEXT |  | NULL | `redacted` 時は NULL |
| `occurred_at` | TIMESTAMPTZ | ✓ | — | |
| `stats_json` | JSONB |  | NULL | `{ additions, deletions, filesChanged, commentCount }` |
| `labels_json` | JSONB |  | NULL | allowlist 通過分のみ |
| `share_policy` | TEXT | ✓ | — | この行が push されたときのポリシー (`redacted` / `full`)。 監査用 |
| `owner_user_id` | TEXT | ✓ | — | |
| `owner_user_name` | TEXT | ✓ | — | |
| `shared_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `shared_origin` | TEXT |  | NULL | |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | |

- UNIQUE: `(owner_user_id, repo_key, kind, ref)` — 同じ実績を同じ人が二重に出さない。
  **他人が同じ commit を出すのは許す** (共同作業のため)
- Index: `idx_worklog_occurred` (`occurred_at DESC`) /
  `idx_worklog_owner_occurred` (`owner_user_id, occurred_at DESC`) /
  `idx_worklog_repo` (`repo_key, occurred_at DESC`) /
  `idx_worklog_parent` (`parent_ref`)

### `worklog_digests` (Hub)

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK (subject key になる) |
| `scope_kind` | TEXT | ✓ | — | `user` / `repo` / `topic` |
| `scope_key` | TEXT | ✓ | — | user id / repo_key / topic 文字列 |
| `period_start` / `period_end` | DATE | ✓ | — | 対象期間 |
| `rev` | INTEGER | ✓ | 1 | append-only。 同 (scope, period) で再生成すると +1 |
| `summary_md` | TEXT | ✓ | — | 何をやったか |
| `highlights_json` | JSONB |  | NULL | 代表 entry の ref 配列 |
| `metrics_json` | JSONB |  | NULL | `{ prCount, commitCount, additions, deletions, activeDays }` |
| `generated_by` | TEXT | ✓ | — | user id + モデル名 |
| `owner_user_id` / `owner_user_name` | TEXT | ✓ | — | |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | |

- UNIQUE: `(owner_user_id, scope_kind, scope_key, period_start, period_end, rev)`
- Index: `idx_worklog_digests_scope` (`scope_kind, scope_key, period_end DESC`)

## 5. dig room

### `dig_rooms`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK (subject key) |
| `title` | TEXT | ✓ | — | |
| `question` | TEXT | ✓ | — | 掘る問い (1 文) |
| `theme` | TEXT |  | NULL | ローカル `dig_sessions.theme` と揃える軸 |
| `state` | TEXT | ✓ | `'open'` | `open` / `digesting` / `converged` / `archived` |
| `llm_policy` | TEXT | ✓ | `'any_member'` | `any_member` / `creator_only` / `local_model_only` |
| `created_by` | TEXT | ✓ | — | |
| `created_by_name` | TEXT | ✓ | — | |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `updated_at` | TIMESTAMPTZ | ✓ | `now()` | contribution / digest で bump |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | |

Index: `idx_dig_rooms_state_updated` (`state, updated_at DESC`) / `idx_dig_rooms_theme`

### `dig_room_members`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `room_id` | UUID | ✓ | — | FK → `dig_rooms(id)` CASCADE |
| `user_id` | TEXT | ✓ | — | |
| `user_name` | TEXT | ✓ | — | |
| `role` | TEXT | ✓ | `'digger'` | `owner` / `digger` |
| `joined_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `last_seen_at` | TIMESTAMPTZ |  | NULL | 「未読 contribution」 算出用 |

PK: `(room_id, user_id)`

### `dig_contributions`

**append-only**。 UPDATE / DELETE しない (取り消しは `kind='retract'` 行で表現)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK |
| `room_id` | UUID | ✓ | — | FK → `dig_rooms(id)` CASCADE |
| `seq` | BIGINT | ✓ | — | room 内の連番 (`room_id, seq` で順序確定。 差分取得に使う) |
| `kind` | TEXT | ✓ | — | `query` / `source` / `finding` / `question` / `dead_end` / `dig_import` / `bookmark_ref` / `note_ref` / `retract` |
| `payload_json` | JSONB | ✓ | — | kind ごとの shape ([feature §2.2](../feature/hub-dig-rooms.md#22-dig_contributions--append-only-の書き込み)) |
| `canonical_url` | TEXT |  | NULL | `kind='source'` のとき正規化 URL を切り出して保持 (重複検出 index 用) |
| `url_hash` | TEXT |  | NULL | `sha256(canonical_url)` |
| `target_contribution_id` | UUID |  | NULL | `retract` / `finding`→`question` の解決対象 |
| `author_user_id` / `author_user_name` | TEXT | ✓ | — | |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `hidden_at` / `hidden_by` / `hidden_reason` | | | NULL | |

- UNIQUE: `(room_id, seq)` / `idx_dig_contrib_url` UNIQUE (`room_id, url_hash`)
  WHERE `url_hash IS NOT NULL` — **同 room 内で同一 URL の source を二重登録させない**
  (`?force=1` は `payload_json.forced=true` を立てた別 kind ではなく、
  既存行への `finding` 追加に誘導する)
- Index: `idx_dig_contrib_room_seq` (`room_id, seq`) / `idx_dig_contrib_kind` (`room_id, kind`)

### `dig_room_digests`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK (subject key にもなる) |
| `room_id` | UUID | ✓ | — | FK → `dig_rooms(id)` CASCADE |
| `rev` | INTEGER | ✓ | — | 1 から連番 |
| `summary_md` | TEXT | ✓ | — | 問いに対する現時点の答え |
| `sources_json` | JSONB |  | NULL | 採用 source (`[{ url, title, role }]`) |
| `open_questions_json` | JSONB |  | NULL | |
| `dead_ends_json` | JSONB |  | NULL | |
| `metrics_json` | JSONB |  | NULL | `{ sourceCount, newSourceSinceLastRev, findingCount, openQuestionCount, contributorCount }` |
| `covered_seq` | BIGINT | ✓ | — | この rev が読んだ contribution の最大 seq (次 rev の差分起点) |
| `generated_by` | TEXT | ✓ | — | user id + モデル名 (Hub 生成時は `hub`) |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |

UNIQUE: `(room_id, rev)`

### `dig_room_jobs`

digest 生成の依頼キュー ([feature §5](../feature/hub-dig-rooms.md#5-まとめ生成をどこで回すか))。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | UUID | ✓ | `gen_random_uuid()` | PK |
| `room_id` | UUID | ✓ | — | FK → `dig_rooms(id)` CASCADE |
| `state` | TEXT | ✓ | `'queued'` | `queued` / `claimed` / `done` / `failed` |
| `requested_by` | TEXT | ✓ | — | |
| `from_seq` | BIGINT | ✓ | — | 前 rev の `covered_seq` |
| `claimed_by` | TEXT |  | NULL | user id または `hub` |
| `claimed_at` | TIMESTAMPTZ |  | NULL | |
| `lease_expires_at` | TIMESTAMPTZ |  | NULL | claim から 5 分。 期限切れは `queued` に戻す |
| `attempts` | INTEGER | ✓ | 0 | 3 回失敗で `failed` 固定 |
| `error` | TEXT |  | NULL | |
| `result_digest_id` | UUID |  | NULL | FK → `dig_room_digests(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | ✓ | `now()` | |

- Index: `idx_dig_jobs_queue` (`state, created_at`) — claim の取り合いは
  `UPDATE ... WHERE state='queued' ... RETURNING` の 1 文で行う (row lock)
- 同 room で `queued` / `claimed` の job は **同時に 1 本まで** (部分 UNIQUE index)

## 6. Hub のメンバー / 通知

### `hub_members`

拠点ローカルの役割。 Cernere のユーザ属性とは別。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `user_id` | TEXT | ✓ | — | PK (Cernere user id) |
| `user_name` | TEXT | ✓ | — | 最終ログイン時の表示名 |
| `role` | TEXT | ✓ | `'member'` | `member` / `moderator` / `admin` |
| `first_login_at` / `last_login_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `disabled_at` | TIMESTAMPTZ |  | NULL | 非 NULL = 書き込み禁止 |

初回ログイン時に upsert。 最初のユーザは `admin` を自動付与。

### `notifications`

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | BIGSERIAL | ✓ | — | PK |
| `user_id` | TEXT | ✓ | — | 宛先 |
| `kind` | TEXT | ✓ | — | `reply` / `mention` / `like` / `subject_activity` |
| `subject_id` | UUID |  | NULL | FK → `subjects(id)` CASCADE |
| `comment_id` | UUID |  | NULL | FK → `comments(id)` CASCADE |
| `actor_user_id` / `actor_user_name` | TEXT | ✓ | — | 誰の行為か |
| `created_at` | TIMESTAMPTZ | ✓ | `now()` | |
| `read_at` | TIMESTAMPTZ |  | NULL | |

- Index: `idx_notifications_user_unread` (`user_id, read_at NULLS FIRST, created_at DESC`)
- 自分の行為で自分に通知は作らない (`actor_user_id <> user_id` をアプリ側で保証)
- 保持は 90 日 (既読は 30 日) で削除するバッチを持つ

## 7. 既存テーブルへの追加

### `bookmarks` (Hub, migration 008)

```sql
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS url_canonical TEXT;
CREATE INDEX IF NOT EXISTS idx_bookmarks_url_canonical ON bookmarks(url_canonical);
```

既存行は起動時バックフィル (`url` → canonical 化)。 `url_canonical` は
`subjects.key` と突き合わせるための列で、 **持ち主付きコピーの構造は変えない**
(= 破壊的移行をしない)。

## 8. ローカル SQLite 側の追加分

正本は `server/db.ts` の CREATE TABLE。 spec としては以下を追加する。

### `worklog_sources` (新規、 [`spec/data/`](./README.md) 側)

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `source_kind` | TEXT | ✓ | — | `github` / `git_local` / `activity` / `impl_note` / `manual` |
| `repo_key` | TEXT |  | NULL | `<owner>/<name>` |
| `local_path` | TEXT |  | NULL | `git_local` のクローンパス |
| `alias` | TEXT |  | NULL | `redacted` 共有時の別名。 未設定で `redacted` は拒否 |
| `share_policy` | TEXT | ✓ | `'none'` | `none` / `redacted` / `full` |
| `llm_optout` | INTEGER | ✓ | 0 | 1 = digest / 要約の材料にも使わない |
| `enabled` | INTEGER | ✓ | 1 | 取り込み有効 |
| `last_ingested_at` | TEXT |  | NULL | UTC ISO |
| `created_at` / `updated_at` | TEXT | ✓ | UTC | |

UNIQUE: `(source_kind, repo_key, local_path)`

### `worklog_entries` (ローカル)

Hub 版 (§4) と同じ列に加えて:

| 列 | 型 | 役割 |
|---|---|---|
| `source_id` | INTEGER | FK → `worklog_sources(id)` |
| `pushed_at` | TEXT | Hub に push した時刻 (NULL = 未 push) |
| `remote_id` | INTEGER | Hub 側 `worklog_entries.id` |
| `redaction_state` | TEXT | `unchecked` / `passed` / `blocked` |
| `redaction_hits_json` | TEXT | blocked の内訳 (どのフィールドにどの語) |

UNIQUE: `(repo_key, kind, ref)`

### `worklog_redaction_terms` (ローカル)

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `term` | TEXT | ✓ | PK。 禁止語 (正規化前の原形) |
| `origin` | TEXT | ✓ | `project_codes` / `manual` / `customer` |
| `created_at` | TEXT | ✓ | |

### 既存テーブルへの追加 (ローカル)

| テーブル | 追加列 | 役割 |
|---|---|---|
| `bookmarks` | `url_canonical` TEXT | Hub subject との突き合わせ。 index 付き |
| `notes` | (変更なし) | UUID なのでそのまま subject key になる |
| `note_comments` | `remote_id` TEXT | Hub `comments.id`。 push 済かの判定 |
| `note_comments` | `anchor_json` TEXT | Hub の anchor 形式に合わせる (既存 `target_block_uuid` は残す) |
| `dig_sessions` | `shared_room_id` TEXT | 持ち込んだ room の UUID |

## 9. 容量の目安

| テーブル | 1 行の目安 | 想定 |
|---|---|---|
| `subjects` | ~300 B | 10k 行 = 3 MB |
| `comments` | ~1 KB | 50k 行 = 50 MB |
| `reactions` | ~120 B | 200k 行 = 24 MB |
| `bookmark_renditions` | 20-80 KB | 2k 記事 = 40-160 MB (案 B の text のみ) |
| `worklog_entries` | ~600 B | 100k 行 = 60 MB |
| `dig_contributions` | ~800 B | 20k 行 = 16 MB |

案 C (HTML) を有効にすると rendition が 1 行 200 KB-2 MB になるため、
`html_content` は Postgres に直接持たず object storage 参照にする余地を残す
(v0.1 では実装しない)。 詳細な見積は [`docs/db-perf-estimate.md`](../../docs/db-perf-estimate.md) の方式に合わせて別途。
