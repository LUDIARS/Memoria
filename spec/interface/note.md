# note — ノート API (rev2)

ノート (UUID 管理) の CRUD + ブロック編集 + コメント集合 + 拡張連携。

## ノート (ヘッダ)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/notes` | `?q=&limit=&offset=&kind=&bookmark_id=` | `{ items: NoteSummary[]; total: number }` |
| GET | `/api/notes/:uuid` | — | `NoteWithBlocks` |
| GET | `/api/notes/:uuid/bookmark-html` | — | `text/html` (sandboxed iframe 用) |
| POST | `/api/notes` | `NoteCreateRequest` | `NoteRow` |
| PATCH | `/api/notes/:uuid` | `NoteUpdateRequest` | `NoteRow` |
| DELETE | `/api/notes/:uuid` | — | `{ ok: true }` |

`POST /api/notes` の body に `bookmark_id` を含めると、 そのブックマークをベースとした note が作成される (`kind='bookmark'` 強制、 `title` 未指定なら bookmark のタイトルを継承)。 通常ノート (`kind != 'bookmark'`) には `bookmark_id` を設定できない (サーバ側で無視)。

`PATCH /api/notes/:uuid` で `bookmark_id` を変更できるのは **null への解除のみ** (= bookmark を切り離す)。 通常ノートに後から bookmark_id を貼り付けることはできない。

`GET /api/notes/:uuid/bookmark-html` は `kind='bookmark'` ノートでのみ 200 を返す (それ以外は 404)。 `<iframe sandbox="allow-same-origin allow-popups allow-forms">` での読み込みを想定。

## ブロック

| method | path | req | res |
|---|---|---|---|
| POST | `/api/notes/:uuid/blocks` | `BlockCreateRequest` | `NoteBlockRow` |
| PATCH | `/api/notes/:uuid/blocks/:blockUuid` | `BlockUpdateRequest` | `NoteBlockRow` |
| DELETE | `/api/notes/:uuid/blocks/:blockUuid` | — | `{ ok: true }` |
| POST | `/api/notes/:uuid/blocks/reorder` | `BlockReorderRequest` | `{ ok: true; blocks: NoteBlockRow[] }` |

`:blockUuid` は `note_blocks.uuid` (TEXT)。 reorder の `order` も block UUID 配列。

## コメント

| method | path | req | res |
|---|---|---|---|
| GET | `/api/notes/:uuid/comment-sets` | `?owner_user_id=` | `{ items: CommentSetWithComments[] }` |
| POST | `/api/notes/:uuid/comment-sets` | `CommentSetCreateRequest` | `CommentSetRow` |
| GET | `/api/notes/:uuid/comment-sets/:setUuid` | — | `CommentSetWithComments` |
| DELETE | `/api/notes/:uuid/comment-sets/:setUuid` | — | `{ ok: true }` |
| POST | `/api/notes/:uuid/comment-sets/:setUuid/comments` | `CommentCreateRequest` | `CommentRow` |
| PATCH | `/api/notes/:uuid/comment-sets/:setUuid/comments/:commentUuid` | `CommentUpdateRequest` | `CommentRow` |
| DELETE | `/api/notes/:uuid/comment-sets/:setUuid/comments/:commentUuid` | — | `{ ok: true }` |

ローカル単独運用では 1 note に **自分の set 1 個**しか存在しない (`UNIQUE(note_id, owner_user_id)`)。 `POST .../comment-sets` は idempotent: 既存があればそれを返す。

## 拡張連携 (既存)

| method | path | req | res |
|---|---|---|---|
| POST | `/api/notes/from-chat` | `NoteFromChatRequest` | `NoteFromChatResponse` |
| POST | `/api/notes/from-notion` | `NoteFromNotionRequest` | `NoteFromNotionResponse` |
| POST | `/api/bookmarks/:id/reparse` | `BookmarkReparseRequest` | `BookmarkReparseResponse` |

`NoteFromChatResponse.note.id` / `NoteFromNotionResponse.note.id` は UUID。

### 保存済 HTML の再パース (`/api/bookmarks/:id/reparse`)

extension は bookmark 保存時に rendered HTML を `html_path` にスナップショットしている。 後から server 側パーサ (`server/parsers/{chat,notion}.ts`) が強化された後でも、 同じスナップショットに対して再抽出を実行して note を作り直せる。

```ts
interface BookmarkReparseRequest {
  /** 省略時は bookmark.url から auto-detect (chatgpt/claude/gemini → 'chat'、 notion → 'notion') */
  kind?: 'chat' | 'notion';
  /** chat の場合の明示指定 (省略時は URL host から判定) */
  chat_source?: 'chatgpt' | 'claude' | 'gemini';
  /** 生成 note の先頭 quote ブロックに付ける任意メモ */
  memo?: string;
}

type BookmarkReparseResponse =
  | { ok: true; kind: 'chat'; source: 'chatgpt' | 'claude' | 'gemini';
      note: NoteRow; messages_saved: number; messages_count: number }
  | { ok: true; kind: 'notion'; note: NoteRow;
      blocks_inserted: number; page_id: string | null };
```

`/api/notes/from-chat` / `/api/notes/from-notion` と同じ `buildChatNote` / `buildNotionNote` ヘルパーで note を作るため、 生成結果は extension 経路と完全に同形 (`kind='chat'` または `'doc'`、 source_kind/source_ref/tags も同じ)。 再パース時は `external_chat_messages` への二重保存を **行わない** (= 初回 extension 取り込み時のみ書き込む)。

エラー:
- `400` URL から chat/notion を auto-detect できず `kind` も渡されていない
- `404` bookmark 行が無い / `html_path` 空 / ファイルが disk から消えている
- `422` パーサが messages / blocks を 1 件も抽出できない (= 保存 HTML が JS shell 状態で DOM が未レンダリングだった場合 等)

### Notion 取り込み

```ts
type NotionExtractedBlock =
  | { kind: 'heading_1' | 'heading_2' | 'heading_3' | 'text' | 'quote' | 'todo'; text: string; checked?: boolean }
  | { kind: 'bullet_list' | 'numbered_list'; text: string; indent?: number }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'divider' };

interface NoteFromNotionRequest {
  url: string;                                 // notion ページ URL
  page_id?: string | null;                     // notion 内部 ID (有効なら conv 用 source_ref)
  title: string;
  blocks: NotionExtractedBlock[];              // extension が DOM scrape したブロック列
  memo?: string;                               // ユーザ追加メモ (1 つ目の text ブロック前に挿入)
  also_bookmark?: boolean;                     // true なら同 URL を bookmark にも保存して embed する (default: false)
}

interface NoteFromNotionResponse {
  note: NoteRow;
  blocks_inserted: number;
  bookmark_id?: number | null;                 // also_bookmark 時に作成された bookmark の id
}
```

note は `kind='doc'` で作成 (= 通常ノート)、 `source_kind='notion'`、 `source_ref=page_id ?? url`。 `also_bookmark=true` の場合は note 末尾に `bookmark_embed` ブロックを 1 つ追加する (= 元 Notion ページへのリンクカード)。

## 型

```ts
interface NoteRow {
  id: string;            // UUID
  title: string;
  kind: NoteKind;
  tags_json: string | null;
  bookmark_id: number | null;
  bookmark_url: string | null;
  source_kind: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
}

interface NoteBlockRow {
  id: number;            // DB 内部 (join 用)
  uuid: string;          // portable UUID
  note_id: string;       // notes.id (UUID)
  position: number;
  block_type: NoteBlockType;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentSetRow {
  id: string;            // UUID
  note_id: string;       // notes.id (UUID)
  owner_user_id: string | null;
  owner_user_name: string | null;
  created_at: string;
  updated_at: string;
  shared_at: string | null;
  shared_origin: string | null;
}

interface CommentRow {
  id: string;            // UUID
  set_id: string;        // CommentSetRow.id
  target_block_uuid: string | null;
  position: number;
  text: string;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentSetWithComments extends CommentSetRow {
  comments: CommentRow[];
}

interface NoteCreateRequest {
  title?: string;
  kind?: NoteKind;
  tags?: string[];
  bookmark_id?: number | null;
  bookmark_url?: string | null;
  source_kind?: string | null;
  source_ref?: string | null;
  initial_blocks?: BlockCreateRequest[];
}

interface BlockCreateRequest {
  block_type: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
  after_block_uuid?: string | null;
}

interface BlockReorderRequest {
  // note 配下のすべての block UUID を含む順序列
  order: string[];
}

interface CommentSetCreateRequest {
  owner_user_id?: string | null;        // NULL = ローカル自分
  owner_user_name?: string | null;
}

interface CommentCreateRequest {
  text: string;
  target_block_uuid?: string | null;
  data?: Record<string, unknown> | null;
}

interface CommentUpdateRequest {
  text?: string;
  target_block_uuid?: string | null;
  data?: Record<string, unknown> | null;
}
```

## バリデーション (既存 + 追加)
- `title` 200 文字、 タグ 32 文字 / 各 max 16 個
- `block_type` enum 外なら 400
- `text` 64KB / `data_json` 32KB
- `BlockReorderRequest.order` は note 配下のすべての block UUID を含む subset NG
- `CommentCreateRequest.text` 16KB / `target_block_uuid` 指定時はその block が存在すること
