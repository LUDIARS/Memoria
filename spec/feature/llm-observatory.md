# LLM 観測所

## 概要

AI アドバイスとは別のトップレベル「LLM」タブに、Claude Code / Codex の利用量、
公式 API 定価による換算コストと Codex credits、キャッシュ効率、セッション・
コンテキスト数、知識資産の増減、利用可能な Local LLM を集約する。

## ユースケース

- 当日・全期間・週次・任意期間の利用量と公式 API 換算コストを、入力 / キャッシュ / 出力の内訳で照合する。
- セッション単位のモデル、コンテキスト数、トークン数を確認する。
- スキル、メモリ、Genius カード、判断ログ、Local LLM の状態を日次で追跡する。

## 画面 / 入口

- Memoria のトップレベル「🧠 LLM」タブ。
- 「ログを更新」で native JSONL と能力資産をバックグラウンド集計する。

## データ

- native JSONL はプロバイダが所有する一次資料で、Memoria は変更しない。
- 読む場所: `~/.claude/projects/**`（サブエージェントの `subagents/agent-*.jsonl` を含む）、
  `$CODEX_HOME/sessions/**`、`$CODEX_HOME/archived_sessions/**`。
- `llm_usage_sources`: source path、mtime、size、取込状態、`parser_version`。source path は API に返さない。
  mtime/size が同じでも、取り込んだ parser の版が現行と異なる source は再読込する。
- `llm_usage_responses`: provider 応答 1 件につき 1 行（主キーは `(provider, response_id)`）。
  トークン内訳、帰属（session / subagent / family / 元ファイルか）、effort、料金版付きのコスト内訳を持つ。
  ダッシュボードはこの表だけを集計する。
- `llm_usage_records`: 旧来の日付・セッション・モデル単位の集計。応答単位へ再評価できないため
  表示には使わず、削除・移行もしない（行数と期間だけを API の `legacy` で示す）。
- `llm_inventory_snapshots`: 能力資産と Local LLM の日次スナップショット。
- 初回は直近8暦日（JST、`MEMORIA_LLM_IMPORT_DAYS` で1〜90日に変更可）の行だけを読み、
  以後は mtime/size か parser 版が変わったファイルを読み直して応答を upsert する。応答行は削除しないので、
  元ログがローテートされても期間外の利用量は保持される。

### 応答の重複除去と帰属

- Claude: stream 中の content block ごとに同じ `message.id` の行が並び、`output_tokens` は累積で増える。
  同じ id の行は各フィールドの最大値（= 最終 usage）に畳み、合算しない。id が無い場合は
  `requestId`、次に `sessionId:uuid` を使う。
- resume / fork で別ファイルへ複製された履歴、Codex の archive 移動は同じ応答 id になるため 1 件に畳む。
  帰属は元ファイル（Claude: ファイル名 = 行の `sessionId`、サブエージェント: `agent-<agentId>`）の値を優先し、
  読込順に依存しない。
- サブエージェント（`isSidechain`）は親 session を `family_id`、自身を `agent_id` として保存し、
  セッション一覧は親 + 子を family 単位で集計する。
- thinking / reasoning は `output_tokens` に含まれるため、別に加算しない。
- cache write は `cache_creation` の 5m / 1h 内訳を保つ。内訳の無い分は TTL 不明として別に数える。
- effort: Codex は各 `turn_context` の `effort`、Claude は行の `effort`（以後の行へ継承）と
  `perTurnEffort`（その行だけ）を記録する。
- 日付は発生時刻の JST 暦日。stream 断片は最初の断片の時刻で日付と取込期間を決める。

### 指標

- コンテキスト数: 重複除去後の応答数（Claude `message.id`、Codex `token_count` の増分）。
- キャッシュヒット率: `cache read / (uncached input + cache read + cache write)`。
- コスト: 公式 API 定価による換算（料金表版 `PRICE_TABLE_VERSION`）。実請求額やサブスク枠の消費ではない。
  - Claude: https://platform.claude.com/docs/en/about-claude/pricing のモデル別単価。cache read の倍率は
    モデルごとに異なる（Opus 5.5 は 0.05 倍、Fable / Mythos 5.1 は 0.025 倍）ため絶対単価で持つ。
  - Codex: https://developers.openai.com/api/docs/pricing の standard 単価。Claude の代理単価は使わない。
  - モデル ID は日付 / region / `[1m]` 接尾辞だけを外して完全一致で引く。`opus` 等の別名、未掲載モデルは
    未評価（`cost_usd` NULL）とし、$0 として合算せず件数・トークン数を別に示す。
  - TTL 不明の cache write は 5 分書込単価（下限）で換算する。
  - 料金表を変えたら版を上げる。同期のたびに版の異なる保存済み応答を再計算するので、ログの mtime が
    変わらなくても（ログが消えていても）新しい単価へ追従する。
  - 未対応: fast mode / data residency / GPT-5.6 long context の割増はログから判別できないため反映しない。
- Codex credits: https://learn.chatgpt.com/docs/pricing の credit 単価で別単位として集計する。
  rate card に無いモデルは credit 未掲載として件数を示す。
- 判断ログ: Memoria BlackBox の `blackbox_decisions` 行数。
- 能力資産: 日次スナップショットを保存し、直前の日次値との差を表示する。
- Local LLM: 設定済み Gamma/OpenAI互換 endpoint の `/models` が応答したモデルだけを利用可能として表示する。

## API

- `GET /api/llm-usage?from=YYYY-MM-DD&to=YYYY-MM-DD`: 当日・総計・日次・週次・期間集計・セッション・
  能力資産・同期状態。期間は JST の `from` 00:00 から `to` の翌日 00:00 まで。省略時は今日を含む直近 7 日。
  不正な日付、`from > to` は 400。
  - `period.summary` / `period.by_model` / `period.by_effort`: 選択期間の全応答を SQL で集計した
    input / cache read / cache write(5m, 1h, 不明) / output のトークンとコスト内訳、未評価件数、Codex credits。
  - `sessions`: 期間内の family を新しい順に最大 500 件。合計は一覧からではなく `period.summary` から出す
    （`period.sessions_total` / `sessions_truncated`）。
- `GET /api/llm-usage/sync`: 同期状態。
- `POST /api/llm-usage/sync`: 同期開始（取込 → 料金版の古い応答の再計算）。同時実行中は既存状態を返す。
- 全 endpoint は direct loopback かつ browser Origin 同一の場合だけ利用できる。

## シェア可能か

🏠 **local-only**。Hub 共有経路は持たず、native JSONL、source path、完全なローカル
repository path、Local LLM endpoint を API に返さない。

## プライバシー観点

- **SPEC-LLM-OBS-PRIVACY:** Local LLM endpoint、API key、外部リクエストの詳細、
  およびそれらを含み得る例外メッセージは、スナップショットにも API にも保存・返却しない。
- DB は差分取込のため source path とプロバイダ由来の session id をローカル保存する。
- API の repository 表示は末尾の project 名だけに縮退する。
- Local LLM の API key と endpoint は保存・返却せず、model id と利用可否だけを保存する。
- JSONL の会話本文、プロンプト、応答本文は読み出し・保存しない。
