# hub-social — 共有サーバの社会層 (subject / コメント / いいね / フィード)

> Memoria Hub を「置き場」 から **共同ナレッジサーバ** に上げる層の設計。
> 関連:
> - [`multi-hub.md`](./multi-hub.md) — Hub の **データハブ役** (Memoria 共有 7 型の JSON CRUD)。 本書はその上に載る
> - [`hub-achievements.md`](./hub-achievements.md) — GitHub / ローカルから「過去やった事」 を取り込んで共有する層
> - [`hub-dig-rooms.md`](./hub-dig-rooms.md) — みんなでディグる (共同 dig)
> - [`hub-aggregation.md`](./hub-aggregation.md) — 他 LUDIARS アプリの横断集約 (別レイヤ、 本書と非依存)
> - schema: [`spec/data/hub-social.md`](../data/hub-social.md) / API: [`spec/interface/hub-social.md`](../interface/hub-social.md)

## 1. 何を解決するか

やりたいことは 4 つ。

1. ノート (**AIノート = `ai_articles` を含む**、 §1.1) を共有する
2. ブックマークを共有する
3. **ブックマークや記事本文にコメントを書ける**
4. **いいねできる**

1 と 2 は multi-hub.md で既に動いている (`/api/data/notes` / `/api/data/bookmarks`)。
3 と 4 が載らないのは、 現状の共有モデルに **共有オブジェクトの同一性 (identity)**
が無いから。

### 現状モデルの構造的な穴

multi-hub.md の共有は「ローカル行を Hub へ push copy する」 モデルで、
Hub 側の行は `BIGSERIAL id` + `owner_user_id` を持つ **持ち主付きコピー**。

```
user A が https://example.com/x をシェア  → hub.bookmarks(id=11, owner=A)
user B が https://example.com/x をシェア  → hub.bookmarks(id=27, owner=B)
user C が https://example.com/x をシェア  → hub.bookmarks(id=48, owner=C)
```

この上に素朴にコメントを足すと `comment.bookmark_id` が 11 / 27 / 48 に散り、
**同じ記事についての議論が 3 つに割れる**。 いいねも 3 分割されるので
「よく読まれている記事」 も出せない。 ノートは UUID なので割れないが、
ブックマーク / 記事本文 / achievements / dig room では割れる。

→ **社会層は「持ち主付きコピー」 ではなく「話題 (subject)」 に紐づける**。
これが本書の中心的な設計判断。

### 1.1 「ノート」 は 2 種類ある

Memoria で「ノート」 と言うと 2 つある。 **両方共有する**。

| | テーブル | 何か | 現状の共有経路 |
|---|---|---|---|
| **ノート** | `notes` / `note_blocks` | 手で書く WYSIWYG ドキュメント (esa 風) | ✅ 既存 `/api/data/notes` |
| **AIノート** | `ai_articles` | 毎朝 6:00 に前日の `activity_events` から自動生成される技術記事 ([`ai-hub.md`](./ai-hub.md)) | ❌ **無い** |

AIノートは `📓ノートへ転写` ボタンで `notes` に写せるので「転写してから共有」 も
できるが、 **自動生成で量が多い**ので転写を共有の前提にすると摩擦が大きい。
→ **`ai_articles` を Hub の共有型に足す** (§1.2)。

### 1.2 AIノート共有で追加が要るもの

| 追加 | 内容 |
|---|---|
| subject kind | `ai_article` (key = `<owner user id>:<article id>`)。 §3.1 の表に追加。 ローカル `ai_articles.id` は **利用者ごとの INTEGER 採番**なので、 id 単体を key にすると別人の無関係な記事が同一 subject に混ざる (§1 の逆向きの事故)。 owner を前置して一意にする |
| Hub 共有型 | `/api/data/ai-articles` = **8 型目**。 Hub Postgres に `ai_articles` テーブル (migration `011`) |
| **redaction ゲート** | ⚠ 必須。 下記 |
| 転写との重複解消 | 下記 |

#### redaction が必須な理由

AIノートの本文は **commit message / AI prompt / repo 名から LLM が生成した文章**。
つまり **private repo 名・顧客名・社内固有名が本文に混入し得る**
([[feedback_external_doc_redaction_rules]])。 手書きノートと違い、
ユーザが 1 文字ずつ書いたものではないので **目視前提にできない**。

→ AIノートの共有は [`hub-achievements.md`](./hub-achievements.md) §4.3 の
**禁止語スキャンを共用**する。 実装も同じ `server/shared/redaction.ts` を通す
(achievements 側と別実装にしない)。 スキャン対象は `title` / `body_md` /
`tags` / `source_refs` / `topic_key`。 1 件でも hit したら共有を中止し、 どのフィールドに
どの語が出たかを返す (自動書き換えはしない)。

さらに `source_refs` は **既定で共有しない**。 commit sha と repo 名の組は
それ自体が private repo の存在を露出するため、 出すのは
`achievement_sources.share_policy` が `full` の repo に限る。
**`achievement_sources` に行が無い repo は `none` 扱い** (= 出さない)。
判定は「`full` を明示的に確認できた repo だけ許す」 allowlist 方向にする —
行が無い / 判定できない場合に通す fail-open にすると、 achievements を
使っていない利用者では repo 名が素通りする ([[feedback_no_extra_fallback]])。
判定関数は `server/shared/` 側に置く (`ai-hub` domain から `achievements` domain の
テーブルを直接読まない — domain 間 cross-import 禁止)。

#### 転写した AIノートの扱い

`ai_articles.note_id` が埋まっている (= `notes` に転写済み) 場合、 同じ内容に
対して `ai_article` subject と `note` subject の 2 つができ、 **議論が割れる**
(§1 で直したはずの問題の再発)。

→ **転写時に subject alias を張る**。 `subject_aliases` に
`(kind='ai_article', key=<owner user id>:<article id>)` → 転写先 `note` subject の id を登録し、
以降 `ai_article` の resolve は note subject を返す。 **note 側を正**とする
(転写は「これは残す価値がある」 という人間の判断なので、 そちらに寄せる)。

#### 共有しないもの

- `ai_article_seeds` (記事ネタ) — 未検証のネタ。 出す価値が無く、 repo 名が生で入る
- `ai_advice` (AIアドバイス) — 個人の生活 / 作業データから生成した個人向け助言。
  日記と同じ機微度なので **local-only**

## 2. 用語

- **subject (話題)** — コメント・いいねが付く先の正規オブジェクト。 `kind` + `key` の
  組で一意。 誰の持ち物でもない (= owner を持たない)
- **anchor (アンカー)** — コメントが本文のどこを指しているかの参照。 記事本文 /
  ノートブロックの中の範囲を指す
- **rendition (レンディション)** — 記事本文の共有スナップショット。 全員が
  「同じ本文」 を見るための content-addressed な保存単位
- **reaction** — いいね等の軽量反応。 v0.1 は `like` のみ
- **feed** — 直近に動いた subject の一覧。 「みんなが今どこを掘っているか」 の入口

## 3. subject モデル

### 3.1 subject 種別と key

| kind | key の形 | 由来 | 用途 |
|---|---|---|---|
| `bookmark` | `<canonical-url>` | URL 正規化 (§3.2) | ブックマーク / 記事そのもの |
| `note` | `<note uuid>` | `notes.id` | ノート全体 |
| `ai_article` | `<owner user id>:<article id>` | `ai_articles.id` (利用者ごと採番なので owner を前置) | AIノート (§1.2)。 転写済なら `note` subject に alias される |
| `note_block` | `<note uuid>/<block uuid>` | `note_blocks.uuid` | ノートの特定ブロック |
| `dig_room` | `<room uuid>` | `dig_rooms.id` | 共同 dig の部屋 ([`hub-dig-rooms.md`](./hub-dig-rooms.md)) |
| `achievement_entry` | `<provider>:<owner>/<repo>:<kind>:<ref>` | `achievement_entries` | 個々の実績 (commit / PR / release) |
| `achievement_digest` | `<digest uuid>` | `achievement_digests.id` | 期間まとめ ([`hub-achievements.md`](./hub-achievements.md)) |
| `dictionary_term` | `<normalized term>` | `dictionary_entries.term` | 用語 (同じ語について全員で議論できる) |

subject は **要求時に生成される** (get-or-create)。 コメント / いいねを付けようと
した瞬間に `subjects` へ upsert され、 それまでは存在しない。 これにより
「シェアされていない URL にコメントが付く」 (= 記事は共有されているが Hub 上に
bookmark 行が無い) 状態も自然に扱える。

> subject は **共有オブジェクトの有無に依存しない**。 `bookmark` subject が
> あって Hub 上に `bookmarks` 行が 0 件でも成立する (URL だけが同一性の根拠)。
> 逆に `bookmarks` 行が 3 件あっても subject は 1 つ。

### 3.2 URL 正規化 (canonical URL)

`bookmark` subject の同一性はここで決まるので、 **ローカルと Hub で同一実装**を
使う。 実装は `server/shared/canonical-url.ts` に置き、 Hub (`server/multi/`) は
それを import する (domain 間 cross-import 禁止のため `shared/` 配置)。

手順 (決定的):

1. scheme / host を lowercase、 `http` → `https`、 既定ポート (`:80` / `:443`) を除去
2. host の末尾 `.` を除去、 IDN は punycode 正規化
3. path: 連続スラッシュを 1 つに畳む。 末尾スラッシュを除去 (path が `/` 単体のときは残す)
4. fragment を除去。 ただし `#!` 始まり、 および §3.3 の domain ルールで
   「hash がルートを表す」 と宣言された host は保持
5. query: **除去リスト**にマッチするキーを落とす —
   `utm_*` / `gclid` / `gbraid` / `wbraid` / `fbclid` / `msclkid` / `igshid` /
   `mc_cid` / `mc_eid` / `_ga` / `_gl` / `yclid` / `spm` / `ref` / `ref_src` /
   `ref_url` / `share` / `s` (twitter/x のみ) / `si` (youtube のみ)
6. 残った query を **キー昇順**でソート (同キーは値昇順)。 空値キー (`?a=`) は保持
7. percent-encoding: unreserved 文字は decode、 残りは大文字 hex に統一
8. 全体を Unicode NFC 正規化
9. 結果文字列を `subjects.key`、 `sha256(key)` を `subjects.key_hash` に保存
   (長い URL の index 効率と UNIQUE 制約のため。 UNIQUE は `(kind, key_hash)`)

### 3.3 domain 別ルール

一般則だけでは同一性を取り違えるサイトがあるので、 host 単位の上書きを持つ。

| ルール | 例 |
|---|---|
| `keep_query` — 指定キーのみ残す | `youtube.com`: `v` `list` のみ / `docs.google.com`: `id` のみ |
| `keep_hash` — fragment を保持 | SPA ルーティングのドキュメントサイト |
| `strip_path_suffix` — 末尾を落とす | `/amp` / `/index.html` |
| `alias_host` — host を寄せる | `m.example.com` → `example.com` / `youtu.be` → `youtube.com` (`/xxx` → `/watch?v=xxx`) |

ルールは `url_canonical_rules` テーブル (Hub) + 同内容の既定 JSON (ローカル同梱) で持つ。
**Hub 側ルールが正**で、 ローカルは起動時 / Multi 接続時に pull してキャッシュする。
ルール変更で既存 subject の key が変わりうるので、 ルール更新は
`subject_key_migrations` に記録し、 旧 key → 新 key の **別名解決** (`subject_aliases`)
を残す (= 過去のコメントが迷子にならない)。

## 4. コメント

### 4.1 データ構造 — flat + 1 段返信

```
comments(id uuid, subject_id, author_user_id, parent_comment_id?, anchor_json?, body_md, ...)
```

- **flat**。 `parent_comment_id` は 1 段だけ許す (返信の返信は同じ親にぶら下げる)。
  深いツリーは読みにくく、 UI コストが跳ねるので v0.1 では取らない
- 本文は **markdown インライン + ブロック** (ノート本文と同じサブセット)。 HTML は保存しない
- `anchor_json` が NULL = subject 全体へのコメント、 非 NULL = 本文内アンカー付き

### 4.2 既存 `note_comment_sets` との整合

ローカル SQLite には既に
[`note_comment_sets`](../data/note.md#note_comment_sets) (1 note × 1 user) +
`note_comments` の 2 段構造がある。 Hub 側では **set テーブルを持たない**。

> **set = (subject, author) でグルーピングした comments の射影**として扱う。
> `GET /api/social/comments?subject=<id>&group=author` が set 相当のレスポンスを返す。

理由: achievements / bookmark / dig room にもコメントを付けるので、 「note 専用の
set テーブル」 を全 kind ぶん増やすと table が kind 数だけ増える。 グルーピングは
クエリで足りる。

ローカル側の 2 段構造は **自分のコメントのローカル原本**として維持する
(オフラインで書ける / Local モードで見える)。 共有時に
`note_comment_sets` 配下の各行が Hub の `comments` 1 行として push され、
`note_comments.remote_id` に Hub 側 id が記録される。

### 4.3 anchor — 記事本文 / ブロック本文へのコメント

「記事内容にコメント書ける」 の中核。 アンカーは
**W3C Web Annotation Selector に倣った複数セレクタの束**にする。
1 つの手段に賭けると本文がわずかに変わった時に全部迷子になるため。

```ts
type Anchor = {
  /** 解決対象。 bookmark subject なら rendition、 note_block なら block 本文 */
  target: { kind: 'rendition'; renditionId: string }
        | { kind: 'note_block'; noteId: string; blockUuid: string };
  selectors: Array<
    | { type: 'TextQuote';    exact: string; prefix?: string; suffix?: string }
    | { type: 'TextPosition'; start: number; end: number }
    | { type: 'CssPath';      value: string; startOffset: number; endOffset: number }
    | { type: 'Point';        x: number; y: number }   // canvas 用 (下記)
  >;
};
```

**解決順**: `TextQuote` → `TextPosition` → `CssPath`。 先に解決できたものを採る。

- `TextQuote` は本文の差分に強い (prefix/suffix 32 文字で曖昧性を除去)
- `TextPosition` は高速。 rendition が完全一致するとき有効
- `CssPath` は画像やテーブルなど非テキスト要素へのアンカー用
- `Point` は既存の
  [`floating_text.anchor`](../data/note.md#floating_text-の-data_json-shape) の
  `kind:'point'` 相当。 ブックマークノートの canvas に貼った付箋を社会層に
  上げるときの互換用。 既存 `kind:'text'` (selector + startOffset/endOffset) は
  `CssPath` セレクタに 1:1 で写せる

**解決失敗時は消さない**。 `comments.anchor_state` を `resolved` / `orphan` に
分け、 orphan は「本文にひもづかないコメント」 として一覧の末尾に出す。
本文が更新されて再解決できたら `resolved` に戻す (再解決は表示時に試行)。

### 4.4 記事本文の共有 (rendition)

記事本文にアンカー付きコメントを打つには、 **全員が同じ本文を見ている**必要がある。
ところが現状 Hub は HTML を持たない (migration 001 のコメント:
`HTML body is *not* stored here; only the metadata.`)。 各自のローカル
アーカイブは取得時刻もリーダー抽出結果も違うので、 そのままではアンカーが揃わない。

3 案を LUDIARS 標準軸で比較 (主目的 =「同じ本文を指して議論できること」)。

#### A. rendition を持たない (ライブページに対して解決)

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★☆☆☆ — セレクタ解決だけ |
| 作業コスト | 小 — 追加ストア無し |
| 目的達成度 | ★★☆☆☆ — ページ改変 / 消滅 / ログイン壁で壊れる。 各自の閲覧結果も揃わない |
| 主目的一致度 | ★★☆☆☆ — 「同じ本文」 が保証されない |

#### B. Hub が抽出本文 (text) のみ持つ

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★☆☆ — 本文抽出の決定化 + content addressing |
| 作業コスト | 中 — `bookmark_renditions` + 抽出パイプラインの共通化 |
| 目的達成度 | ★★★★☆ — TextQuote / TextPosition が安定して効く。 図表は指せない |
| 主目的一致度 | ★★★★★ — 保存するのは共有意図のある記事の本文のみ。 容量も小さい |

#### C. Hub が HTML スナップショットも持つ

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★★☆ — sanitize / 資産 rewrite / 容量管理 |
| 作業コスト | 大 — object storage・sanitizer・容量上限・削除運用 |
| 目的達成度 | ★★★★★ — 見た目ごと同一。 `CssPath` / `Point` も効く |
| 主目的一致度 | ★★★☆☆ — 第三者ページの複製を共有サーバに置くことになる (再配布の色が付く) |

#### 推奨: **B を v0.1、 C は opt-in 拡張**

- **v0.1 = B**。 `bookmark_renditions` に「抽出本文 (text) + 見出し構造 + sha256」 を保存。
  アンカーは `TextQuote` + `TextPosition` の 2 本で十分に効く
- **C は per-bookmark の明示 opt-in** (`share_html=true`) にして、 サーバ設定で
  機能自体を無効化できるようにする。 拠点ポリシーで「本文複製は置かない」 を選べる
- rendition は **content-addressed** (`sha256(normalized_text)` を id 代わりの
  `content_hash` に)。 同じ記事を 3 人がシェアしても本文は 1 つ。
  取得時刻の違いで本文が変わった場合は rendition が 2 つ並び、
  コメントは自分が打った rendition に紐づく。 UI は「最新 rendition」 を既定表示し、
  他 rendition のコメントは TextQuote 再解決を試みてマージ表示する

## 5. いいね (reaction)

```
reactions(id, target_kind('subject'|'comment'), target_id, user_id, kind, created_at)
UNIQUE (target_kind, target_id, user_id, kind)
```

- v0.1 の `kind` は `like` のみ。 将来の絵文字リアクションのために列は残す
  (`kind` を enum 化せず TEXT + アプリ側 allowlist)
- **subject にも comment にも付く**。 「記事にいいね」 と「コメントにいいね」 は同じ経路
- カウンタは `subjects.like_count` / `comments.like_count` に非正規化し、
  **DB トリガで維持**する (アプリ側インクリメントは二重計上・欠落が出るため)。
  整合確認用に `POST /api/social/admin/recount` を持つ
- 取り消しは `DELETE` (行を消す)。 誰がいいねしたかは
  `GET /api/social/reactions?target=...` で取れる (拠点内は相互に見える前提)

## 6. フィード — 「みんなでディグれる」 の入口

社会層があっても入口が無いと使われない。 `GET /api/feed` が
**直近に動いた subject** を返す。

- 並び: `active` (最終アクティビティ降順) / `new` (subject 作成降順) /
  `liked` (期間内 like 数降順) / `hot` (like + comment を時間減衰させたスコア)
- 絞り込み: `kinds` / `tags` / `repo` (achievements) / `author` / `since`
- 各行は `{ subject, latestActivity, commentCount, likeCount, participants[], excerpt }`
- `subject_activity` テーブル (subject × 日 の集計) を持ち、 フィードと
  「掘り尽くし度」 表示の両方が使う
- ミュート: `subject_mutes` (user × subject) — 自分のフィードから外す

## 7. 通知

- `notifications(id, user_id, kind, subject_id, comment_id?, actor_user_id, read_at)`
- `kind`: `reply` (自分のコメントへの返信) / `mention` (`@user` 記法) /
  `like` (自分のコメント / 自分がシェアしたオブジェクトへの like) /
  `subject_activity` (watch している subject が動いた)
- watch: 自分がコメント or like した subject は自動 watch。 `subject_watches` で明示追加も可
- 配送は **ローカルが pull して自分の端末に出す**。 Hub は WebPush 鍵を持たない
  (`push_subscriptions` はローカル専用テーブルのまま)。 ローカルが Multi 接続中に
  `GET /api/notifications?unread=1` を定期取得し、 既存の
  [push-notification](./push-notification.md) 経路で通知する

## 8. 権限・モデレーション・濫用対策

| 対象 | 作成 | 編集 | 削除 |
|---|---|---|---|
| comment | member | 作者のみ | 作者 / moderator |
| reaction | member | — | 本人のみ |
| subject | member (get-or-create) | moderator (title 等) | 不可 (hide のみ) |
| rendition | member (シェア時) | — | moderator (hide) |

- role は `hub_members(user_id, role)` — `member` / `moderator` / `admin`。
  Cernere のユーザ属性ではなく **Hub ローカルの役割**として持つ (拠点ごとに違うため)
- 削除は soft delete (`deleted_at` + 本文を空文字に置換)。 スレッドの構造を壊さない
- moderator の hide は既存 7 型と同じ `hidden_at` / `hidden_by` / `hidden_reason` を踏襲
- レート制限: comment = 30/10min/user、 reaction = 300/10min/user、
  rendition upload = 60/hour/user。 超過は `429 { error: 'rate_limited', retryAfter }`
- 本文サイズ: comment `body_md` ≤ 16 KiB、 rendition text ≤ 1 MiB

### 8.1 公開の取り下げ (unshare)

> **決定 (neco 2026-07-30)**: 拠点内のグループ単位の部分公開は **持たない**
> (ログインできる = 拠点メンバー = 相互に読める)。 その代わり
> **一度公開したものを取り下げられる**ことを保証する。 取り下げは
> **管理権限 (moderator / admin) の操作**として設計する。

取り下げは 3 段階。 段階が上がるほど不可逆になる。

| 段階 | 何が起きるか | 実行できるのは |
|---|---|---|
| `hide` | `hidden_at` / `hidden_by` / `hidden_reason` を立てる。 一覧 / フィード / API から消えるが **DB 行は残る** (復帰可・監査可) | 出した本人 / moderator |
| `unshare` | Hub の行を削除。 ローカル原本は残り、 ローカルの `shared_at` をクリアして「未共有」 に戻す | 出した本人 / moderator |
| `purge` | subject ごと削除。 配下の `comments` / `reactions` / `bookmark_renditions` も CASCADE で消える。 **復帰不可** | admin のみ |

- **本人取り下げ**: `owner_user_id` が自分の行 (共有 8 型 = 既存 7 型 + `ai_articles` /
  `achievement_entries` / `bookmark_renditions` / 自分の `comments`) は本人が
  `hide` / `unshare` できる。
  moderator 権限を待たずに引っ込められる方が事故対応が速い
- **他人のもの**の取り下げは moderator。 `purge` だけは admin に限る
- **既定は subject を残す**。 元オブジェクトを取り下げても subject 行は残し、
  `title` を「(取り下げ済)」 に置換する。 理由: **他人のコメントは他人のもの**なので、
  出した人の一存で消えない。 議論ごと消す必要がある場合は admin の `purge`
- **監査を残す**。 `unshare_audit` に「誰が・何を・いつ・どの段階で・理由」 を記録する。
  取り下げ自体を「なかったこと」 にはしない
- **ローカルへの伝播**: ローカルは Multi 接続時に
  `GET /api/social/unshares?since=` を引き、 自分の行の `shared_at` を
  クリア / 復元する。 他人が取り下げたものはローカルに何も無いので伝播不要
  (§9 のとおり他人のデータをローカルに持たない設計が効いている)
- 取り下げは **退会処理の代替ではない**。 ユーザ自体の削除は Cernere 側の
  責務で、 Hub 側は `hub_members.disabled_at` + 本人の全 `unshare` までを担う

## 9. Local / Multi との関係 (どこにデータが在るか)

> ⚠ **撤回 (neco 指示 2026-07-31)**: 下記の「他人のデータをローカルに持たない」 方針は
> [`hub-sync.md`](./hub-sync.md) で**撤回された**。 Hub の内容は差分同期でローカルに落ちる
> (`source_hub_id` で自分の行と分離)。 同期の前提として必要なため。 本節の記述は
> proxy モデル時代のもので、 Phase 6 の proxy 撤去まで併存する。

social 層は **Hub 専用**。 v0.1 では他人のコメント / いいねを
ローカル SQLite に永続化しない。

| データ | ローカル SQLite | Hub Postgres |
|---|---|---|
| 自分のコメント (note) | ✅ 原本 (`note_comment_sets` / `note_comments`) | ✅ push copy |
| 自分のコメント (bookmark / achievements / dig room) | ❌ (v0.1 は Hub 直書き) | ✅ 原本 |
| 他人のコメント | ❌ 保持しない | ✅ |
| いいね | ❌ | ✅ |
| rendition | ローカルの `html/` アーカイブ (既存) | ✅ 抽出本文 (共有分のみ) |
| フィード / 通知 | ❌ | ✅ |

- **Local モード**では社会層は見えない。 ただし「この記事は Hub に N 件コメント」 の
  バッジだけは、 接続済 Hub があれば on-demand で問い合わせて出す
  (`GET /api/social/subjects/resolve` を 1 回叩くだけ。 結果はメモリキャッシュ 60 秒)
- **Multi モード**では社会層をライブ読み書きする (multi-hub.md §5.3 の proxy に相乗り)
- 双方向同期エンジンは **作らない**。 「他人の書いたものはサーバにあり、
  ローカルには落ちてこない」 を明示的な境界にする。 落としたくなったら
  それは v0.2 以降の別設計 (conflict 解決が必要になる)

## 10. プライバシー観点

- 社会層に載るのは **共有意図のあるオブジェクトについての発言**だけ。
  個人ログ (diary / GPS / meals / visits / activity) は subject 化しない
  (multi-hub.md §4 の ❌ 群は kind として存在しない)
- `dictionary_term` subject は用語文字列のみを key にする。 その語をいつ
  どこで調べたか (= 検索意図) は Hub に出さない
- rendition に載るのは第三者ページの抽出本文。 自分の memo / 要約は
  既存 `bookmarks.memo` / `summary` の共有ポリシーに従う (= 明示シェア分のみ)
- 通知は Hub 上で生成されるが、 端末への配送はローカル経由。 WebPush の
  endpoint / 鍵は Hub に出さない
- ログにはユーザ本文を出さない。 subject id / kind / 件数・所要時間まで
  (hub-aggregation.md §10 と同方針)

## 11. 実装フェーズ

| Phase | 内容 |
|---|---|
| 0 | **AIノート共有** — Hub `ai_articles` テーブル (migration 011) + `/api/data/ai-articles` (8 型目) + `server/shared/redaction.ts` の禁止語スキャン共用。 社会層より前に出せる (既存 7 型と同じ形なので) |
| 1 | `server/shared/canonical-url.ts` + `subjects` / `subject_aliases` / `url_canonical_rules`。 `bookmarks.url_canonical` 列追加 + 既存行バックフィル。 `GET/POST /api/social/subjects/resolve` |
| 2 | `comments` + `reactions` + トリガ (カウンタ)。 subject 全体コメント + いいね。 ローカル Multi モード UI (ノート / ブクマ詳細にコメント欄) |
| 3 | `bookmark_renditions` (案 B: 抽出本文) + anchor 解決 (`TextQuote`/`TextPosition`)。 記事本文への範囲コメント |
| 4 | `note_block` anchor + 既存ローカル `note_comment_sets` の push/pull 配線 (`remote_id` 記録) |
| 5 | `subject_activity` + `GET /api/feed` + ミュート。 フィード UI |
| 6 | `notifications` + watch + ローカル pull → WebPush 配送 |
| 7 | moderation (hide / soft delete / role) + **取り下げ 3 段階 (§8.1) + `unshare_audit`** + レート制限 + `recount` |
| 8 | (opt-in) 案 C の HTML rendition + `CssPath` / `Point` anchor |

Phase 1-3 で「ノート / ブクマを共有して記事にコメントしていいねする」 が成立する。
[`hub-achievements.md`](./hub-achievements.md) / [`hub-dig-rooms.md`](./hub-dig-rooms.md) は
Phase 2 完了後に並走できる (subject + comment + reaction があれば載る)。

## 12. オープン論点

1. ~~**拠点内は全部見える前提でよいか**~~ → **決定済 (2026-07-30)**。 部分公開は
   持たず、 代わりに取り下げ (§8.1) を用意する。 `subject_visibility` は作らない
2. ~~**AI ノートの取り込み経路**~~ → **解消 (2026-07-30)**。 AIノートは Memoria の
   `ai_articles` (`ai-hub.md`) であり、 外部 (Notion) の記事ではない。 §1.2 で
   Hub 共有型として直接扱う。 外部記事の取り込みは本設計の対象外
3. **rendition の保持期間** — 記事本文をいつまで持つか。 コメントが 1 件も無い
   rendition を GC してよいか
4. **`dictionary_term` の正規化** — 大文字小文字 / 全角半角 / 送り仮名の寄せをどこまでやるか
5. **匿名 like を許すか** — 拠点が小さいと「誰がいいねしたか」 が常に分かる。
   それを嫌う運用があるか
