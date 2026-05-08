# privacy-settings — プライバシー設定

## 概要
各機能の ON/OFF / 表示 / シェア許可を集中管理。 `app_settings` の `features.*` キーを `privacySettings()` で正規化して返す。 PATCH で変更すると、 一部 (MCP autostart) は即時反映される。

## ユースケース
- 軌跡 (GPS) / 食事 / Actio タスク共有 / Nuntius リマインダー / MCP autostart / workplace 自動共有 を個別 ON/OFF
- `*_visible` 系で「データは溜めるが UI には見せない」 二段階制御 (例: tracks は記録だけ続けて表示は OFF)
- workplace 半径 (`workplace_match_radius_m`) や reminder 時刻 (`tasks_reminder_hour/minute`) も同経路で設定

## 画面 / 入口
- 設定 → `プライバシー / 表示` タブ

## 設定キー (一覧)

| body field | settings key | 効果 |
|---|---|---|
| `tracks_enabled` | `features.tracks.enabled` | GPS ingestion 全停止 |
| `tracks_visible` | `features.tracks.visible` | UI 上の軌跡タブ非表示 |
| `meals_enabled` | `features.meals.enabled` | 食事の記録 / 編集禁止 |
| `meals_visible` | `features.meals.visible` | 食事タブ + 一覧空応答 |
| `tasks_actio_share_enabled` | `features.tasks.actio_share.enabled` | Actio share 経路有効化 |
| `tasks_reminder_enabled` | `features.tasks.reminder.enabled` | 朝のタスク reminder push |
| `tasks_reminder_nuntius_enabled` | `features.tasks.reminder.nuntius_enabled` | Nuntius 経由 reminder |
| `mcp_autostart_enabled` | `features.mcp.autostart.enabled` | MCP server autostart (即時反映) |
| `workplace_geo_enabled` | `features.workplace.geo.enabled` | GPS チェックイン許可 |
| `workplace_auto_share_enabled` | `features.workplace.share.enabled` | enter/leave の Hub 自動配信 |
| `actio_share_url` | `actio.share_url` | Actio タスク share endpoint |
| `tasks_reminder_hour` / `minute` | `features.tasks.reminder.hour` / `minute` | reminder 時刻 |
| `workplace_match_radius_m` | `features.workplace.match.radius_m` | チェックイン半径 (20-2000m) |
| `tasks_reminder_nuntius_url` | `features.tasks.reminder.nuntius_url` | Nuntius プロキシ URL |

## データ
- [app_settings](../db/settings.md) — 上記キーをすべて格納

## API
- [config.md](../api/config.md) — `GET /api/privacy/settings` / `PATCH /api/privacy/settings`

## シェア可能か
**local-only**

設定値そのものは外に出さない (個人ポリシーの宣言なので)。

## プライバシー観点
- **個人データを保持するテーブル**: `app_settings` の各 feature flag。 機微度は中。 `actio.share_url` / `tasks_reminder_nuntius_url` は外部 endpoint URL (組織内 IP / hostname を含む可能性あり)。
- **LLM プロバイダに送る情報**: なし。 ただしフラグの組み合わせで下流の LLM 呼び出し有無が変わる (`meals_enabled=false` で vision 呼び出しが止まる等)。
- **共有時に外部に出ない情報**: 全部。
- **削除時の挙動**: PATCH で空文字 / false を送るとそれぞれ無効化。 `mcp_autostart_enabled` を OFF にすると `onMcpAutostartChange` 経由で MCP 子プロセスが SIGTERM される。
