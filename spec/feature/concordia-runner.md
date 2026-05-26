# concordia-runner — AI 委託の Concordia spawn 経由実行

## 概要

[agent.md](agent.md) の AI 委託は既定で **ローカル直 spawn** (`claude -p ...` / `codex exec ...` / `gemini -p ...` を `child_process.spawn` で non-interactive 起動 → stdout を `agent_logs/` に tee) するが、 Concordia + Lictor が動いている環境では **Concordia の `/v1/spawn` で Lictor-wrapped セッションを Windows Terminal タブに起動** → 起動した session に prompt を inject して進める経路を選択できる。

設定 `llm.task_runner = concordia` を入れた時だけ有効化され、 既定値の `local` ではこれまでの挙動を維持する (= Concordia が無い環境を壊さない選択式)。

## なぜ Concordia 経由を選ぶか

- **可視化**: wt タブで Claude/Codex の TUI がそのまま見えるので、 進行中の AI 出力をユーザが直接観察 / 介入できる
- **一元監視**: Concordia の dashboard / chat / persona がそのまま乗る (Lictor wrap 経由なので skill 注入 / permission proxy / transcript-tail も自動)
- **長期 session の再利用**: 既存 session への inject 拡張 (Phase 2) で「いつもの Claude に作業を渡す」 動線が作れる

## ユースケース

- 重い実装タスク (UI ありで進捗を見ながら判断したい場合) を Memoria の AI 委託ボタンから wt タブで起動
- non-interactive で完結する軽量タスク (lint / typo 直し) は従来通り `local`

## 画面 / 入口

- v0.1: `llm.task_runner` を `/api/config` 経由で `concordia` に切り替え → 既存の `AI 委託` ボタンの挙動が分岐
- v0.2 (後続 PR): UI に runner toggle、 task 単位で local/concordia override 可

## データ

- 既存 `agent_runs` に 2 カラム追加:
  - `mode TEXT NOT NULL DEFAULT 'local'` — `'local'` | `'concordia'`
  - `concordia_session_id TEXT` — Concordia が割り当てた session id (`lictor-<uuid>`)、 spawn 直後は NULL、 poll で session 検出後に set
- ログ: `concordia` モードでは `agent_logs/` に **spawn と inject のメタイベントのみ** を 1 ファイルに記録する (stdout/stderr 本体は wt タブ側にある)
- 既存の `prompt` カラムには inject した本文をそのまま保存する (後追い検証用)

## API

- 既存 `POST /api/tasks/:id/agent-run` / `POST /api/agent-runs` の payload はそのまま、 内部で settings を見て分岐する
- `cancelAgentRun` は **concordia モードでは no-op + 警告**: wt タブを Memoria から殺すと Lictor のクリーンアップに副作用がある可能性があるため、 ユーザに wt 側で `/exit` するよう促す

## Concordia 側に依存するエンドポイント (既存)

- `GET /v1/spawn/info` (no auth) — token_path を返す
- `POST /v1/spawn` (Bearer token) — `{ provider: 'claude'|'codex'|'gemini', mode: 'tab', cwd, args, title? }` で wt タブ起動
- `GET /v1/sessions?status=active&provider=...` — Memoria 側で `repo_path` + `started_at > spawnTs` を client-side filter で session を特定
- `POST /v1/sessions/:id/inject` — Lictor の WS reactor 経由で pty に prompt を流し込む

Concordia 側 (主に `/v1/sessions` の filter) には今回は変更入れない。 必要なら別 PR で `repo_path` filter を追加する。

## 失敗時の振舞い (= 選択式の徹底)

| 失敗ポイント | 振舞い | 理由 |
|---|---|---|
| `GET /v1/spawn/info` 接続失敗 | `agent_runs.status = 'failed'`、 summary に `concordia unreachable: ...` を記録。 **local fallback はしない** | 「選択式」 = ユーザが明示的に concordia を選んだ意図を尊重。 silent fallback だと「Concordia 死んでるのに気付かない」 リスク |
| token 読み込み失敗 | 同上、 summary に `spawn token unreadable: <path>` を記録 | Concordia 起動 user と Memoria 起動 user が違うとパーミッションで詰まる |
| `POST /v1/spawn` が 4xx/5xx | 同上、 response body を summary に記録 | Concordia の log を見るための breadcrumb |
| 30s 経っても session 検出できず | `status = 'failed'`、 summary に `session not detected within 30s` | wt 起動には数秒かかるが 30s で出ないなら何かおかしい |
| `POST /v1/sessions/:id/inject` が 4xx/5xx | session_id は記録、 status = 'failed'、 summary に response | wt タブは残るので、 ユーザが手で prompt 貼れば運用継続可能 |

local fallback したい場合は `llm.task_runner` を `local` に戻すか、 後続 PR で `llm.task_runner = auto` (= concordia 優先、 unreachable なら local fallback) を導入する余地は残す。

## シェア可能か

**local-only** ([agent.md](agent.md) と同じ理由)。 `concordia_session_id` は外部に出ない。

## プライバシー観点

- **Memoria → Concordia 間**: prompt 本体が `POST /v1/sessions/:id/inject` で loopback HTTP を通る。 Concordia は SQLite に inject イベントとして payload を記録する ([Concordia: events table](../../../Concordia/spec/db.md))。
- **wt タブで起動した CLI**: ユーザの API key で claude/codex/gemini API に prompt を送る。 LLM 提供者には agent.md と同じ範囲の情報が出る。
- **個人データ保管禁止ルール ([project_personal_data_rule])**: 該当なし (実装ログ + spawn メタのみ)。

## 設定キー

| key | 既定値 | 説明 |
|---|---|---|
| `llm.task_runner` | `local` | `local` (現行)、 `concordia` (本機能) |
| `llm.concordia.url` | `http://127.0.0.1:17330` | Concordia loopback URL |

`llm.concordia.token_path` は持たない (毎回 `/v1/spawn/info` から取得する。 token rotation に追従するため)。
