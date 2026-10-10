---
task: diary-external-sections
project: Memoria
kind: 実装
taskflow_reference: actio:36f4912d-56b3-431e-b526-ee04c04ce378
created: 2026-10-10T00:00:00.000Z
---
# 日記の外部節とテキストからのノート取り込み口 (Concordia デイリーゴールのまとめの受け口)

## 背景 (neco 指示 2026-10-10)

> 次の日の朝4時を締め切りとして、4時にその日やったことをまとめる。まとめた結果はMemoriaの日記とノートに記載される。

Concordia (Cc) のデイリーゴール自走が、毎朝 4:00 にその日 (4:00〜翌4:00) のまとめを作って Memoria へ渡す。
Cc 側の正本: `E:/Document/Ars/Concordia/spec/feature/daily-goal-run.md` の「Memoria との契約」と §8
(Cc の branch `feat/daily-goal-post-entry`、未マージ)。
今の Memoria には外部サービスから日記の一部やノートを書く口が無い (`PATCH /api/diary/:date` はユーザメモ `notes` を
丸ごと置き換えるので使えない。`/api/notes` は Tabula 移行で 410)。この PR で受け口を作る。

## 契約 (Cc が呼ぶ。loopback)

| メソッド | パス | body | 意味 |
|---|---|---|---|
| PUT | `/api/diary/:date/sections/:source` | `{ title, markdown }` | その日の外部節を置き換える (無ければ作る)。日記の他の欄 (summary / work_content / highlights / notes) は変えない。日記行が無ければ行を作らずに節だけ保存してよい |
| GET | `/api/diary/:date/sections/:source` | — | 1 件。無ければ 404 |
| GET | `/api/diary/:date/sections` | — | その日の外部節の一覧 |
| DELETE | `/api/diary/:date/sections/:source` | — | 外部節を消す (人間の操作用) |
| POST | `/api/notes/from-text` | `{ external_id, title, markdown, source }` | Markdown を Tabula のノートとして取り込む。同じ `external_id` が既にあれば作らずに既存を返す (200)、新規は 201。返り値に note の id / url |

- `date` は `YYYY-MM-DD`、`source` は `[a-z0-9-]{1,64}`。`title` は 200 字、`markdown` は 200KB で上限。超えたら 400。
- 書き込みはローカル (loopback) からだけ受ける。既存の `/api/notes/*` は `localTabulaAccess` を通しているので同じ扱いにする。
  `/api/diary/*` の既存の認可方式に合わせ、外部節の書き込みが外へ開かないことを確認する。
- `from-text` は Tabula 取り込み (`importToTabula`) が成功してから対応表を保存する (失敗をローカル成功に見せない。既存 from-chat と同じ)。

## 決めてあること

- 保存: 新テーブル `diary_sections (date TEXT, source TEXT, title TEXT NOT NULL, markdown TEXT NOT NULL, created_at, updated_at, PRIMARY KEY(date, source))`。
  `external_notes (external_id TEXT PRIMARY KEY, source TEXT, note_id TEXT, note_url TEXT, created_at)`。
  migration は既存の方式・採番規則に従う (並行ブランチの番号衝突に注意)。
- 表示: 日記の詳細パネルに外部節を `title` 見出し + Markdown 本文で出す (notes の下)。編集 UI は持たず、削除だけ。
  入力 UI を足す場合は `.foundation-form`。
- 日記の再生成 (`/api/diary/:date/generate`) は外部節を消さない。`DELETE /api/diary/:date` は外部節も消す。spec のプライバシー観点に書く。
- `diary_sections` は日記と同じく local-only (Hub シェア対象外)。日記の LLM 生成 (work/highlights/weekly) に外部節は渡さない (今回は表示と保存だけ)。
- 仕様: `spec/feature/diary.md`、`spec/data/diary.md`、`spec/interface/diary.md` (無ければ該当の interface 文書) に外部節と from-text を書く。
  ドメイン宣言 `spec/domains/memo-and-diary.domain.json` の membership に新ファイルが入るか確認し、入らなければ足す。
- God Class を増やさない。`server/diary.ts` が大きければ外部節は別ファイル (例: `server/diary/sections.ts`) に切る。
  domain 間の cross-import 禁止 (共通は `server/shared/`)。

## テストと受入

- 外部節の upsert / 他欄を変えない / 一覧 / 削除、from-text の冪等 (同じ external_id で 2 回呼んでも 1 本)、Tabula 失敗時に対応表を残さない、入力上限、のテストを同じ変更で書く。
- 実行してよいのは typecheck と build だけ。単体・統合・起動テストの実行と Memoria の再起動はしない (登録テストは Revisor)。
- PR 本文に変更した境界・復旧方法 (migration を戻す方法)・実施/未実施の検証を書く。
