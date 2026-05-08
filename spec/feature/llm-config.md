# llm-config — LLM プロバイダ設定

## 概要
タスクごと (要約 / dig / wordcloud / 日記 / 食事 vision 等 12 タスク) に **どの LLM プロバイダ** (Claude CLI / Codex CLI / Gemini CLI / OpenAI API / アルゴリズム) を使うか、 どの **モデル** を使うかを設定する。 OpenAI のみ API key を Memoria サーバに保持、 残り 3 種は CLI バイナリをユーザの API key スコープで呼ぶ。

## ユースケース
- 「日記ハイライトは Opus 4.7 (1M)、 ブクマ要約は Sonnet」 のようなタスク別ルーティング
- ローカル CLI バイナリ (`claude` / `gemini` / `codex`) のパスを overide
- diary global memo (毎回の日記生成 prompt 末尾に貼られる立ち位置メモ)
- ユーザプロファイル (年齢 / 性別 / 体重 / 身長 / 活動量) を栄養計算に使う

## 画面 / 入口
- 設定 → `AI / LLM` タブ — 12 タスク × プロバイダ / モデル選択 + diary memo + user profile
- 公開 endpoint で 12 タスク + 5 プロバイダ + モデル一覧を返す

## データ
- 設定: `app_settings.llm.*` (プロバイダ / モデル / バイナリパス / API key)
- 関連: `app_settings.diary.global_memo` / `user.age` / `user.sex` / `user.weight_kg` / `user.height_cm` / `user.activity_level`
- runtime: `runtime.git_bash_path` (Windows + claude CLI 用、 memory `feedback_claude_cli_windows_bash.md`)

## API
- [config.md](../api/config.md) — `GET /api/llm/config` (タスク + プロバイダ + モデル + 現状) / `PATCH /api/llm/config` (設定更新、 API key は `'***'` で来たら無視)

## シェア可能か
**local-only**

API key と CLI binary path はマシン固有の機微情報。 シェア対象外。

## プライバシー観点
- **個人データを保持するテーブル**: `app_settings.llm.openai.api_key` (OpenAI API key、 `getLlmConfig` から **取り出すときだけ** plain で返り、 API レスポンス時に `'***'` でマスクされる)、 `user.*` のプロファイル (健康情報)、 `diary.global_memo` (個人指示メモ)。
- **LLM プロバイダに送る情報**: 設定値そのものは LLM に送らない。 設定によって決まる **下流タスク** (要約 / wordcloud / dig / 日記 / 食事 vision) で各プロバイダにデータが流れる。 各 feature 個別の「LLM プロバイダに送る情報」 を参照。
- **共有時に外部に出ない情報**: 全部 (シェア対象外)。
- **削除時の挙動**: PATCH で空文字を送ると key/value が空になる。 OpenAI API key を空にすると、 そのプロバイダに割り当てたタスクは失敗する。
