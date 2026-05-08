# note — ノート API

ノート (markdown ライク WYSIWYG) の CRUD + ブロック編集 + 拡張からのチャット取り込み。

## ノート (ヘッダ)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/notes` | `?q=&limit=&offset=&kind=` | `{ items: NoteSummary[]; total: number }` |
| GET | `/api/notes/:id` | — | `NoteWithBlocks` |
| POST | `/api/notes` | `NoteCreateRequest` | `NoteRow` |
| PATCH | `/api/notes/:id` | `NoteUpdateRequest` | `NoteRow` |
| DELETE | `/api/notes/:id` | — | `{ ok: true }` |

## ブロック

| method | path | req | res |
|---|---|---|---|
| POST | `/api/notes/:id/blocks` | `BlockCreateRequest` | `NoteBlockRow` |
| PATCH | `/api/notes/:id/blocks/:blockId` | `BlockUpdateRequest` | `NoteBlockRow` |
| DELETE | `/api/notes/:id/blocks/:blockId` | — | `{ ok: true }` |
| POST | `/api/notes/:id/blocks/reorder` | `BlockReorderRequest` | `{ ok: true; blocks: NoteBlockRow[] }` |

## 拡張連携

| method | path | req | res |
|---|---|---|---|
| POST | `/api/notes/from-chat` | `NoteFromChatRequest` | `{ note: NoteRow; messages_saved: number }` |

`/api/notes/from-chat` は extension のチャット取り込みボタンから直接呼ばれる。 同時に `external_chat_messages` への bulk insert (1 message = 1 row) も行うことで、 「Note (md 集約)」 と 「セッションログ (1 message 1 行)」 の両方を残す。

## 型

`NoteSummary` (一覧用):
```ts
{
  id: number;
  title: string;
  kind: NoteKind;        // 'doc' | 'chat' | 'meeting' | …
  tags: string[];
  source_kind: string | null;
  source_ref: string | null;
  block_count: number;
  preview: string;       // 先頭 text ブロックの 120 文字
  created_at: string;
  updated_at: string;
}
```

`NoteRow` / `NoteBlockRow` は [db/types/note.ts](../../server/db/types/note.ts) 参照。

`BlockReorderRequest`:
```ts
{
  // 順序を確定したい block id 列。 サーバ側で 1.0, 2.0, 3.0 ... と再採番する。
  order: number[];
}
```

`NoteFromChatRequest`:
```ts
{
  source: 'chatgpt' | 'claude' | 'gemini';
  url: string;
  conversation_id: string | null;
  title: string;
  // 1 message = 1 entry。 user / assistant 交互。 text は markdown 化済 (extension で生成)
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string; ts?: string | null }>;
  // Note も作るか (false の場合は external_chat_messages のみ insert)
  also_create_note: boolean;
  // optional: ユーザの追加メモ (Note 冒頭に埋め込む)
  memo?: string;
}
```

## バリデーション
- `title` は 200 文字、 タグは 32 文字 / 各、 max 16 個
- `block_type` が enum 外なら 400
- `text` は 64KB を上限
- `data_json` は 32KB
- `BlockReorderRequest.order` は note 配下のすべての block id を含むこと (subset NG)
