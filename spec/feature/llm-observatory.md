# LLM 観測所

## 概要

AI アドバイスとは別のトップレベル「LLM」タブに、Claude Code / Codex の利用量、
Villa `/session-costs` を基準にした等価 API コスト、キャッシュ効率、セッション・
コンテキスト数、知識資産の増減、利用可能な Local LLM を集約する。

## ユースケース

- 当日・全期間・週次の利用量と等価 API コストを比較する。
- セッション単位のモデル、コンテキスト数、トークン数を確認する。
- スキル、メモリ、Genius カード、判断ログ、Local LLM の状態を日次で追跡する。

## 画面 / 入口

- Memoria のトップレベル「🧠 LLM」タブ。
- 「ログを更新」で native JSONL と能力資産をバックグラウンド集計する。

## データ

- native JSONL はプロバイダが所有する一次資料で、Memoria は変更しない。
- `llm_usage_sources`: source path、mtime、size、取込状態。source path は API に返さない。
- `llm_usage_records`: 日付・セッション・モデル単位の派生利用量。
- `llm_inventory_snapshots`: 能力資産と Local LLM の日次スナップショット。
- 初回は直近8暦日（JST、`MEMORIA_LLM_IMPORT_DAYS` で1〜90日に変更可）の行だけを読み、
  以後は mtime/size が変わったファイルの期間内集計だけを置換する。期間外へ移った集計は、
  元ログがローテートされても保持する。

### 指標

- コンテキスト数: Codex は `turn_context`、Claude は message id / uuid で重複除去した usage 応答数。
- キャッシュヒット率: `cache read / (uncached input + cache read + cache write)`。
- コスト: Villa `/session-costs` の USD / 100万 token と cache 係数を使用する等価 API 推定。
  実請求額やサブスク残量ではない。未登録モデルは `unpriced` としてコストへ加算しない。
- 判断ログ: Memoria BlackBox の `blackbox_decisions` 行数。
- 能力資産: 日次スナップショットを保存し、直前の日次値との差を表示する。
- Local LLM: 設定済み Gamma/OpenAI互換 endpoint の `/models` が応答したモデルだけを利用可能として表示する。

## API

- `GET /api/llm-usage`: 当日・総計・日次・週次・セッション・能力資産・同期状態。
- `GET /api/llm-usage/sync`: 同期状態。
- `POST /api/llm-usage/sync`: 同期開始。同時実行中は既存状態を返す。
- 全 endpoint は direct loopback かつ browser Origin 同一の場合だけ利用できる。

## シェア可能か

🏠 **local-only**。Hub 共有経路は持たず、native JSONL、source path、完全なローカル
repository path、Local LLM endpoint を API に返さない。

## プライバシー観点

- DB は差分取込のため source path とプロバイダ由来の session id をローカル保存する。
- API の repository 表示は末尾の project 名だけに縮退する。
- Local LLM の API key と endpoint は保存・返却せず、model id と利用可否だけを保存する。
- JSONL の会話本文、プロンプト、応答本文は読み出し・保存しない。
