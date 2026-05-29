# Memoria — Claude Code ルール

## プロジェクト概要

Memoria はライフログ + ナレッジ管理ハブ (Node + better-sqlite3 + Electron + Web)。
ローカル完結型で、 個人データは手元の SQLite に閉じる。
LUDIARS 短縮コード: **Mm**。

詳細は [`README.md`](README.md) / `docs/` を参照。

## コード規約 (Memoria 固有)

共通: `coding-conventions` skill (= `AIFormat/RULE_CODE.md`) を参照。 以下は Memoria 固有の上書き / 追加。

### God Class 警戒

- 既存に複数の God Class があり(`server/<domain>` 配下の大型 `Manager` / `Service` / `Handler` 等)、 新規追加は **禁止**。
- 1 文で説明して「と」 「かつ」 が複数出るクラスは責任過多 → 着手前に分割案を出す。
- **既存 God Class を触る PR では同 PR 内で SRP 分割を試みる**。 5 ファイル超増えるなら別 PR にして「分割 PR + 機能 PR」 を順に出す。

### 機能ごとのファイル分割

- `server/<domain>/` で domain を区切る (= `bookmarks` / `notes` / `dig` / `diary` / `dictionary` / `lifelog` / `summarizer` 等)。
- domain 間の cross-import は禁止。 共通ヘルパは `server/shared/` に置く (= 「`bookmarks` から `notes` を直接読む」 ではなく、 必要なら `shared/` に共通 interface を切る)。
- **将来の切り出し前提**: bookmarks / notes / dig 等の「ナレッジ系」 は独立サービス化候補。
  - LUDIARS 共有層 (Cernere / Corpus / Foundation UI 等) に対する依存はインターフェース境界に閉じ込めて差し替え可能にする。
  - 切り出し時に **「`mv server/bookmarks/ ../bookmarks-service/server/` だけで動く」** 境界に保つ (= bookmarks 配下のコードは Memoria 固有 path / DB schema に直結しない)。

### レイヤ依存

- `server/` ← `electron/` ← `web/` の単方向。 上層から下層を import するのは OK、 逆は禁止。
- `client/` (= Chrome 拡張) は server に対し HTTP / IPC のみ。

### 入力 UI

- text 系 input / select / textarea は **`.foundation-form`** 統一 ([[feedback_memoria_foundation_input]] / `memoria-foundation-ui` skill)。

### 個人データ

- 個人データはローカル SQLite に閉じる ([[project_personal_data_rule]])。 LUDIARS 共有 DB / 外部 API に流さない (= シェアは明示的 opt-in のみ)。

## 参照

- `coding-conventions` skill / `memoria-foundation-ui` skill / [[project_memoria]] / [[feedback_memoria_foundation_input]] / [[project_personal_data_rule]] / [[feedback_memoria_push_triggers]]
