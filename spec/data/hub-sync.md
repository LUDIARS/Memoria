# hub-sync — 同期のテーブル定義 (Hub Postgres + ローカル SQLite)

> 機能側: [`../feature/hub-sync.md`](../feature/hub-sync.md) / API: [`../interface/hub-sync.md`](../interface/hub-sync.md)
> Hub 側の社会層テーブルは [`hub-social.md`](./hub-social.md) が正本。

## 0. migration 割り当て

| 側 | migration | 内容 |
|---|---|---|
| Hub (Postgres) | `012_change_log.sql` | `hub_changes` + 既存 8 型 CRUD からの書き込み |
| ローカル (SQLite) | `server/db.ts` | `hub_servers` / `hub_sync_state` / `hub_pushes` + 各共有テーブルへの `source_hub_id` 追加 |

## 1. Hub: `hub_changes`

同期の単一情報源。 **削除を拾える**ことと **単調な rev** を持つことが目的
([feature §4.1](../feature/hub-sync.md#41-なぜ-change-log-が要るか))。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `rev` | BIGSERIAL | ✓ | — | PK。 **単調増加**。 同期カーソルの正体 |
| `type` | TEXT | ✓ | — | `bookmarks` / `notes` / `ai-articles` / `subjects` / `comments` / … (API の `<type>` と同じ語彙) |
| `row_id` | TEXT | ✓ | — | 対象行の id (型が混在するので TEXT)。 API では `id` として返す ([interface §2](../interface/hub-sync.md#2-hub-変更ログと初回スナップショット)) |
| `op` | TEXT | ✓ | — | `upsert` / `delete` |
| `owner_user_id` | TEXT |  | NULL | 誰の行か (可視性フィルタ用) |
| `changed_at` | TIMESTAMPTZ | ✓ | `now()` | 情報列。 **順序判定には使わない** (時計のずれを持ち込まない) |

- Index: `rev` は PK index で足りる。 追加は `idx_hub_changes_type_rev` (`type, rev`) —
  畳み込み / 型別の点検用 (同期の追いかけ自体は型で絞らない、
  [interface §2](../interface/hub-sync.md#2-hub-変更ログと初回スナップショット))
- 各 type の INSERT / UPDATE / DELETE は **同一トランザクションで 1 行書く**。
  トリガでも良いが、 アプリ側 (`server/multi/data.js`) の 1 箇所に集約する方が
  「書き忘れ」 を見つけやすい
- **保持期間**: 同 (type, row_id) の古い `upsert` 行は畳んでよい (最新 rev だけ残す)。
  ただし `delete` は畳まない (tombstone が消えると取り下げが伝播しない)。
  畳み込みは `since` より古い rev に対してのみ行う (未同期クライアントを壊さない)

## 2. ローカル: `hub_servers`

登録した Hub。 現行 `app_settings.multi_servers` (JSON) を **テーブルに昇格**させる。
同期状態・push 先選択・source 表示で参照が増えるため、 JSON のままだと扱いにくい。
併存する `app_settings.multi_active_urls` (現行の「接続中」 集合) は
ソースセレクタの選択状態に置き換わるので、 Phase 6 の proxy 撤去時に破棄する。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK。 `source_hub_id` が指す先 |
| `url` | TEXT | ✓ | — | UNIQUE。 末尾スラッシュ除去済み |
| `label` | TEXT | ✓ | — | 表示名 |
| `cernere_url` | TEXT |  | NULL | この Hub が属する Cernere ([feature §10-1](../feature/hub-sync.md#10-オープン論点)) |
| `project_key` | TEXT |  | NULL | project-token 発行時の対象 project |
| `delta_rev` | INTEGER | ✓ | 0 | **Hub ごとに 1 本**の差分カーソル。 全型が `delta` に入ってから進める ([feature §4.2](../feature/hub-sync.md#42-差分取得)) |
| `sync_enabled` | INTEGER | ✓ | 1 | 0 = 登録だけして同期しない |
| `push_allowed` | INTEGER | ✓ | 1 | 0 = この Hub には push させない |
| `added_at` / `updated_at` | TEXT | ✓ | UTC | |

> **`jwt` 列は作らない**。 access / project-token はメモリのみ、 refresh token は
> 暗号化ストア ([feature §2.4](../feature/hub-sync.md#24-資格情報の保管))。
> 現行 `multi_servers.jwt` からの移行時に平文トークンを持ち越さない。

## 3. ローカル: `hub_sync_state`

初回分割取得の再開位置と、 差分の追いかけ位置。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `hub_id` | INTEGER | ✓ | — | FK → `hub_servers(id)` CASCADE |
| `type` | TEXT | ✓ | — | 同期対象の型 |
| `phase` | TEXT | ✓ | `'initial'` | `initial` (スナップショット取得中) / `delta` (差分追従) |
| `cursor` | TEXT |  | NULL | initial のページカーソル。 中断・再開に使う |
| `snapshot_rev` | INTEGER |  | NULL | スナップショット開始時の rev。 delta 移行時の起点 |
| `last_rev` | INTEGER | ✓ | 0 | この型で最後に適用した rev (進捗表示・診断用)。 **追いかけの正本は `hub_servers.delta_rev`** — 型別に進めると型をまたぐ順序が壊れる |
| `item_count` | INTEGER | ✓ | 0 | 進捗表示用 |
| `last_synced_at` | TEXT |  | NULL | UTC |
| `last_error` | TEXT |  | NULL | 直近の失敗理由 (UI に出す。 無言で止めない) |

PK: `(hub_id, type)`

## 4. ローカル: `hub_pushes`

「何をどの Hub に出したか」。 取り下げ ([`../feature/hub-social.md`](../feature/hub-social.md) §8.1) の
対象特定と、 二重 push の防止に使う。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `hub_id` | INTEGER | ✓ | — | FK → `hub_servers(id)` CASCADE |
| `type` | TEXT | ✓ | — | |
| `local_id` | TEXT | ✓ | — | ローカル行の id |
| `remote_id` | TEXT |  | NULL | Hub 側 id (取り下げに使う) |
| `share_policy` | TEXT |  | NULL | push 時のポリシー (監査) |
| `pushed_at` | TEXT | ✓ | UTC | |
| `unshared_at` | TEXT |  | NULL | 取り下げ済みなら時刻 |

UNIQUE: `(hub_id, type, local_id)` WHERE `unshared_at IS NULL`

## 5. 既存テーブルへの追加 (ローカル)

同期で入った行を **自分の行と混ぜない**ための列。

| テーブル | 追加列 | 役割 |
|---|---|---|
| `bookmarks` / `notes` / `dig_sessions` / `dictionary_entries` / `implementation_notes` / `work_locations` / `domain_catalog` / `ai_articles` | `source_hub_id` INTEGER | NULL = 自分。 非 NULL = その Hub から同期した行 |
| 同上 | `remote_id` TEXT | Hub 側 id。 差分適用時の突き合わせに使う |
| 同上 | `remote_rev` INTEGER | 適用済みの rev。 古い差分の再適用を弾く |

- Index: 各テーブルに `(source_hub_id, remote_id)` の UNIQUE
  (同じ Hub の同じ行を二重に入れない)
- **既存行は `source_hub_id = NULL`** のままなので、 移行は列追加だけで済む
  (破壊的移行なし)
- 表示側は既定で `source_hub_id IS NULL` (= ローカル) を出し、 セレクタで広げる
  ([feature §5](../feature/hub-sync.md#5-要件-4-表示ソースの選択))
- 本書が定義するのは **共有 8 型ぶんだけ**。 社会層 (`comments` / `reactions` …) /
  achievements / dig room はローカルに受け皿テーブルが無く、 Phase 3 の対象外
  ([feature §10-6](../feature/hub-sync.md#10-オープン論点))

## 6. 資格情報 (テーブルではない)

refresh token は **DB に置かない**。 `<DATA>/credentials/cernere.json.enc` に
暗号化して保存する ([feature §2.4](../feature/hub-sync.md#24-資格情報の保管))。

| 保存先 | 中身 | 寿命 |
|---|---|---|
| 暗号化ファイル | refresh token / user id / cernere url | 永続 |
| プロセスメモリ | access token / project-token (hub 別) | exp まで |
| `app_settings` | **何も置かない** | — |

現行 `multi_servers[].jwt` (平文の Hub session token) は移行時に破棄する。

## 7. 容量の目安

| テーブル | 1 行 | 想定 |
|---|---|---|
| `hub_changes` | ~120 B | 100k 行 = 12 MB (畳み込み前) |
| `hub_sync_state` | ~200 B | Hub 数 × 型数 = 数十行 |
| `hub_pushes` | ~200 B | 10k 行 = 2 MB |
| 同期で入る共有 8 型 | 元データ次第 | **他人のデータが入るので上限設計が要る** ([feature §10-3](../feature/hub-sync.md#10-オープン論点)) |
