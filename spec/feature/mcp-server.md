# mcp-server — MCP server autostart

## 概要
Memoria 同梱の MCP server (`mcp-server/index.js`) を Memoria 子プロセスとして spawn。 Claude Desktop / Claude Code から `add_task` `list_tasks` `search_bookmarks` `list_diary_entries` 等の Memoria API を叩けるようにする。

## ユースケース
- Claude Desktop の会話中に「これブクマしといて」 → 直接 Memoria に登録
- Claude Code セッションで「今日の日記取ってきて」 → MCP 経由
- autostart ON で Memoria 起動と一緒に MCP server が立つ

## 画面 / 入口
- 設定 → `プライバシー` → `MCP autostart` チェック (`mcp_autostart_enabled`)
- ON / OFF を変更すると `onMcpAutostartChange` 経由で `McpServerControl.sync` が走り、 子プロセスを start / stop

## データ
- 設定値のみ: `app_settings.features.mcp.autostart.enabled`
- 子プロセスは state を DB に持たない (PID は `McpServerControl` 内でのみ保持)
- セットアップガイド: `/api/setup-docs/mcp` で Markdown を返す (Claude Desktop / Code config 例)

## API
- [config.md](../interface/config.md) — `/api/privacy/settings` PATCH `mcp_autostart_enabled` / `/api/setup-docs/mcp`
- 子プロセスへの env: `MEMORIA_URL=http://127.0.0.1:<port>` を渡す

## シェア可能か
**local-only**

MCP は完全にローカル機能 (Memoria サーバ + Claude クライアント間の stdio)。 Hub 連携対象外。

## プライバシー観点
- **個人データを保持するテーブル**: なし (起動状態フラグのみ)。 ただし MCP tools 経由で Claude が **Memoria の全 API を叩ける** ため、 結果として個人 DB の中身が Claude に流れる。
- **LLM プロバイダに送る情報**: ユーザの Claude Desktop / Code セッションが必要に応じて Memoria の API を呼んだ結果 (ブクマ / タスク / 日記抜粋等) を Anthropic API に送る。 これはユーザの **Claude 側 API key スコープ**。 Memoria サーバ自身は Anthropic と直接通信しない。
- **共有時に外部に出ない情報**: 全部 (シェア機能なし)。
- **削除時の挙動**: autostart を OFF にすると `SIGTERM` で子プロセスを kill。 Claude Desktop / Code 側の MCP server 設定はユーザ手動で削除。
