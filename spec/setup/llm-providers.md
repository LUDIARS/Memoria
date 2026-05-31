# LLM プロバイダの設定

## 目的

要約 / Dig / 日記 / 食事解析 などの AI タスクを、 どのプロバイダ
(Claude CLI / Gemini CLI / Codex CLI / OpenAI API / アルゴリズム) で処理するかを
**タスク単位** で選ぶ。 既定は全タスク Claude CLI。

## どこに設定するか (= app_settings)

LLM 設定は **env ではなく SQLite の `app_settings`** に入る。 起動後の画面
**⚙ AI** から入力するのが正規ルートで、 再起動しても残る。 起動時に
`loadLlmConfigFromSettings(getAppSettings(db))` が読み込む (`server/index.ts:90` /
`server/llm.ts:124-143`)。

## 設定キー (app_settings)

| キー | 既定 | 説明 | 根拠 |
|---|---|---|---|
| `llm.<task>.provider` | `claude` | タスクごとのプロバイダ | `server/llm.ts:128` |
| `llm.<task>.model` | (プロバイダ既定) | タスクごとのモデル ID | `server/llm.ts:129` |
| `llm.bin.claude` | `claude` | Claude CLI バイナリパス | `server/llm.ts:135` |
| `llm.bin.gemini` | `gemini` | Gemini CLI バイナリパス | `server/llm.ts:136` |
| `llm.bin.codex` | `codex` | Codex CLI バイナリパス | `server/llm.ts:137` |
| `llm.openai.api_key` | `''` | OpenAI API key (openai プロバイダ使用時) | `server/llm.ts:139` |
| `llm.openai.model` | `gpt-4o-mini` | OpenAI モデル ID | `server/llm.ts:140` |
| `runtime.git_bash_path` | env → `''` | Windows の git-bash 絶対パス。 app_settings → `CLAUDE_CODE_GIT_BASH_PATH` の順 | `server/llm.ts:141` |

### プロバイダ一覧 (`server/llm.ts:54-60`)

| key | 種別 | model 指定 | tools |
|---|---|---|---|
| `algorithm` | AI なし (決定論) | ✗ | ✗ |
| `claude` | Claude CLI | ✓ | ✓ |
| `codex` | Codex CLI | ✓ | ✗ |
| `gemini` | Gemini CLI | ✓ | ✗ |
| `openai` | OpenAI Chat API | ✓ | ✗ |

### タスク一覧 (`server/llm.ts:8-27`)

`summarize` / `dig` / `dig_preview` / `cloud_extract` / `cloud_validate` /
`domain_classify` / `page_summary` / `diary_work` / `diary_highlights` /
`diary_weekly` / `meal_vision` / `meal_calorie` / `app_classify` /
`recommendation_agent` / `recommendation_synthesize` / `endpoint_identify` /
`discord_route`。

タスク既定モデル (`server/llm.ts:29-41`) は要約系が `sonnet`、 ハイライト統合 /
週報 / おすすめ統合が `claude-opus-4-7[1m]` (Opus 1M)。

## 手順

1. 使うプロバイダの CLI をインストール (claude / gemini / codex) するか、
   OpenAI API key を用意する。
2. `http://localhost:5180/` → **⚙ AI** を開く。
3. タスク別にプロバイダ + モデルを選ぶ。 OpenAI を選んだタスクがあれば
   `llm.openai.api_key` も入れる。
4. CLI が PATH に無ければ `llm.bin.*` にフルパスを入れる。 Windows で claude を
   使うなら `runtime.git_bash_path` に git-bash の絶対パスを入れる。

env で先に流し込めるのは `CLAUDE_CODE_GIT_BASH_PATH` (git-bash パスの fallback)
だけで、 プロバイダ選択や OpenAI key は UI 専用。

## 注意点

- **UI が env より優先**。 LLM 設定はすべて app_settings が正で、 env では
  上書きできない (`git_bash_path` の fallback を除く / `server/llm.ts:141`)。
- **食事写真の Vision 解析** (`meal_vision`) は vision 対応モデルが要る。
  vision 非対応のプロバイダ / モデルを割り当てると解析が失敗する。
- **`algorithm` を選ぶと AI を呼ばない**。 決定論処理だけで済むタスク
  (集計系など) を AI から外してコスト / レイテンシを下げたいときに使う。
- **モデル ID はプロバイダ依存**。 UI の選択肢 (`server/llm.ts:67-90`) 以外の
  ID を手で入れると CLI / API 側で reject される可能性がある。
- (任意) Memoria が裏で投げたプロンプトと結果を Concordia の chat に流して
  デバッグしたいときは `MEMORIA_CONCORDIA_FORWARD=1` (env)。 既定は無効、
  best-effort で本機能に影響しない (`server/concordia-forward.ts:10-22`)。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| AI タスクが「CLI not found」 | `llm.bin.<provider>` にフルパスを入れる、 または PATH を通す |
| Windows で claude が exit 1 | `runtime.git_bash_path` / `CLAUDE_CODE_GIT_BASH_PATH` に git-bash 絶対パスを設定 |
| OpenAI タスクが 401 | `llm.openai.api_key` が空 / 失効。 ⚙ AI で再入力 |
| 食事写真が解析されない | `meal_vision` に vision 非対応モデルを割当てている |
| 設定したのに反映されない | app_settings は起動時ロード。 設定後に再読込される画面操作か、 サーバ再起動を |

## 関連

- [`README.md`](./README.md) — 設定の優先順位
- [`config-reference.md`](./config-reference.md) — 全キー一覧
- [`../../README.md`](../../README.md) — マルチ LLM プロバイダの機能説明
