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

## Concordia モジュールの契約 (動的 import)

`llm.concordia.module_path` で指定したモジュールは次を満たすこと。 ロード/検証は
`server/concordia-spawn-loader.ts` (`loadConcordiaSpawn`) が行い、 契約違反は明示 Error を投げる
(無言フォールバック禁止)。

- export `createConcordiaSpawn(options?)` (named。 default export の factory も可) を持つ。
- factory は `ConcordiaSpawnApi` (`server/concordia-spawn-client.ts`) を返す:
  - `spawn(input)` — wt タブ等で lictor-wrapped セッションを起動 → `{ ok, id, pid, command }`
  - `waitForSession(input)` — 起動した session の id を解決 (見つからなければ null)
  - `inject(input)` — 起動 session に prompt を流し込む
- 既存の HTTP 実装 `ConcordiaSpawnClient` も同じ `ConcordiaSpawnApi` を満たす (構造的に互換)。

> Concordia 本体の実装 (この契約を満たす export の用意) は **Concordia 側スレで対応**する。
> Memoria 側 (本 spec) はモジュールを動的 import して呼ぶところまで。

## 失敗時の振舞い (= 選択式の徹底)

| 失敗ポイント | 振舞い | 理由 |
|---|---|---|
| モジュール未設定 / import 失敗 / 契約違反 | `agent_runs.status = 'failed'`、 summary に `concordia module load failed: ...` を記録。 **local fallback はしない** | 「選択式」 = ユーザが明示的に concordia を選んだ意図を尊重。 host URL fallback も silent fallback もしない |
| `spawn(...)` が throw | 同上、 summary に message を記録 | モジュール側 (spawn 起動) の失敗を可視化 |
| 30s 経っても session 検出できず | `status = 'failed'`、 summary に `session not detected within 30s` | wt 起動には数秒かかるが 30s で出ないなら何かおかしい |
| `inject(...)` が throw | session_id は記録、 status = 'failed'、 summary に message | wt タブは残るので、 ユーザが手で prompt 貼れば運用継続可能 |

local fallback したい場合は `llm.task_runner` を `local` に戻すか、 後続 PR で `llm.task_runner = auto` (= concordia 優先、 unreachable なら local fallback) を導入する余地は残す。

## シェア可能か

**local-only** ([agent.md](agent.md) と同じ理由)。 `concordia_session_id` は外部に出ない。

## プライバシー観点

- **Memoria → Concordia 間**: prompt 本体は動的 import した Concordia モジュールの `inject(...)` に in-process で渡る (host URL は経由しない)。 Concordia は SQLite に inject イベントとして payload を記録する ([Concordia: events table](../../../Concordia/spec/db.md))。
- **wt タブで起動した CLI**: ユーザの API key で claude/codex/gemini API に prompt を送る。 LLM 提供者には agent.md と同じ範囲の情報が出る。
- **個人データ保管禁止ルール ([project_personal_data_rule])**: 該当なし (実装ログ + spawn メタのみ)。

## 設定キー

| key | 既定値 | 説明 |
|---|---|---|
| `llm.task_runner` | `local` | `local` (現行)、 `concordia` (本機能) |
| `llm.concordia.module_path` | (なし) | Concordia の spawn 実装モジュールへの **ファイルパス**。 ここから動的 import する。 未設定だと concordia モードは fail (host URL fallback はしない)。 |

> **host URL → 動的モジュールロード移行 (2026-06-28)**: 旧 `llm.concordia.url`(`http://127.0.0.1:17330`) を廃し、 Concordia の spawn 実装を **フォルダから動的 import** する方式へ変更した。 host URL は環境次第で存在しないため。 ロードは `server/concordia-spawn-loader.ts` の `loadConcordiaSpawn(path)` に隔離。
