# note — ノート API (rev2)

ノート (UUID 管理) の CRUD + ブロック編集 + コメント集合 + 拡張連携。

## ノート (ヘッダ)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/notes` | `?q=&limit=&offset=&kind=&bookmark_id=` | `{ items: NoteSummary[]; total: number }` |
| GET | `/api/notes/:uuid` | — | `NoteWithBlocks` |
| POST | `/api/notes` | `NoteCreateRequest` | `NoteRow` |
| PATCH | `/api/notes/:uuid` | `NoteUpdateRequest` | `NoteRow` |
| DELETE | `/api/notes/:uuid` | — | `{ ok: true }` |

`POST /api/notes` の body に `bookmark_id` を含めると、 そのブックマークをベースとした note が作成される (`kind='bookmark'`、 `title` 未指定なら bookmark のタイトルを継承)。

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

`NoteFromChatResponse.note.id` は UUID。

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
