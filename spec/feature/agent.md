# agent — Claude / Gemini / Codex エージェント実行

## 概要
タスクから AI コーディングエージェント (Claude Code / Codex / Gemini CLI) を spawn し、 stdout / stderr をストリーム保存しながら実装させる。 cwd と rules は `agent_projects` で管理。

## ユースケース
- タスクをそのまま AI に委託 (「このタスク実装してリポに push して」)
- リポジトリごとにルール (`AGENTS.md` 相当の rules フィールド) を切り替え
- 走行ログを後から検証 / cancel
- task_id 紐付けと project_id 紐付けの両方で走らせ履歴を残す

## 画面 / 入口
- `🗄 データベース` タブ → タスク詳細 → `AI 委託` ボタン
- `agent-projects` 一覧画面でプロジェクト追加 (パス + 名前 + rules + default_agent)

## データ
- [agent_projects](../db/agent.md) — name / path (絶対パス) / rules (Markdown) / default_agent
- [agent_runs](../db/agent.md) — task_id / project_id / agent / model / prompt / status (pending/running/done/failed/cancelled) / pid / log_path / summary
- ログ本体: `<DATA>/agent_logs/<file>` に stdout/stderr を tee

## API
- [agent.md](../api/agent.md) — `/api/agent-projects*` (CRUD) / `/api/agent-runs*` (一覧 / 詳細 / log / cancel) / `/api/tasks/:id/agent-run` (起動)

## シェア可能か
**local-only**

エージェント実行ログは個人 dev 環境の絶対パス + プロンプト + コード変更内容を含むためシェア不可。

## プライバシー観点
- **個人データを保持するテーブル**: `agent_projects` (リポ絶対パス)、 `agent_runs` (プロンプト全体 + summary、 stdout に source code も含まれる)。 `<DATA>/agent_logs/` は機微度高め。
- **LLM プロバイダに送る情報**: ユーザのタスク title + details + agent_projects.rules + 環境情報 (cwd) を、 spawn された CLI (claude / codex / gemini) が **ユーザの API key** で送る。 Memoria サーバ自身が直接 API を叩くわけではなく、 ローカル CLI が転送する形。 Windows では `runtime.git_bash_path` 経由で起動 (memory `feedback_claude_cli_windows_bash.md`)。
- **共有時に外部に出ない情報**: 全部 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/agent-projects/:id` で project 行のみ削除。 関連 `agent_runs` は **残置** (project_id が orphan)。 走行ログファイル (`<DATA>/agent_logs/`) も自動削除しない (手動 cleanup)。
