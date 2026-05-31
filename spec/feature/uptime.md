# uptime — サーバ稼働 / heartbeat 監視

## 概要
Memoria サーバ自身の起動 / 停止 / ダウンタイム / 再起動を `server_events` に記録。 1 秒間隔で `<DATA>/heartbeat.json` に mtime を書き、 次回起動時にギャップを検出して downtime / restart として遡及記録する。

## ユースケース
- 日記の作業時間推定でサーバダウンタイム区間を識別 (データ欠落かどうかを区別)
- SPA で「最後にサーバが生きてた時刻」 をバッジ表示 (`/api/uptime`)
- ダウンタイム > 5 分 = `downtime`、 ≤ 5 分 = `restart` として種別分け

## 画面 / 入口
- 設定 → `稼働状況` セクション (`/api/uptime` + `/api/events`)
- `/api/uptime` で heartbeat + downtime_threshold を返す

## データ
- [server_events](../data/activity.md) — type (start/stop/downtime/restart) / occurred_at / ended_at / duration_ms / details_json
- ファイル: `<DATA>/heartbeat.json` (1 秒間隔で更新)

## API
- [misc.md](../interface/misc.md) `/api/uptime` / `/api/events` (server_events 一覧)
- [visit.md](../interface/visit.md) `/api/worklog/server-events` (日付指定で 1 日分)

## シェア可能か
**local-only**

サーバ稼働ログは個人 PC の動作状況なのでシェア対象外。

## プライバシー観点
- **個人データを保持するテーブル**: `server_events` (PC 起動 / 停止時刻)。 直接的個人情報ではないが、 生活パターン推定の材料になる。
- **LLM プロバイダに送る情報**: 直接送らない。 日記生成の prompt に「ダウンタイム区間あり」 という事実が間接的に入る可能性 (work_minutes 推定の文脈で)。
- **共有時に外部に出ない情報**: 全部。
- **削除時の挙動**: 削除 API 無し。 retention は手動 SQL。 `heartbeat.json` を削除すると次回起動時にギャップ検出が `priorHeartbeat = null` となり、 downtime 行は作られない。
