# Discord タスク通知エンジン

2026-05-30 起草。 [discord-bot.md](./discord-bot.md) の上に載るタスク通知レイヤー。

## 目的

1. **AI カード成形**: Discord (#task 等) に投げた自然文を AI が解釈し、
   `{title / category / due_at / details}` の構造化「タスクカード」に成形して登録 + 確認カードを返信。
2. **トリガー通知エンジン**: 設定したトリガーが発火すると、フィルタに合致する
   アクティブタスクを選び、選んだ Discord チャンネルへカードで通知する。

すべて opt-in / opt-out。Bot 本体 ([[discord-bot]]) が起動しているときだけ動く。

## トリガー (`features.discord.notify.triggers` = JSON 配列)

各トリガー:

```jsonc
{
  "id": "uuid",
  "name": "朝のタスク",
  "enabled": true,
  "trigger": { "type": "time",   "at": "08:00" },                 // 毎日この時刻
  //          { "type": "random", "window": ["09:00","21:00"], "count": 1 }  // 日に count 回、 窓内のランダム時刻
  //          { "type": "gps",    "event": "arrive"|"depart", "radius_m": 200 } // 自宅 geofence 帰宅/出発
  "filter": {
    "categories": ["all"] | ["買い物","開発"],   // "all" or 登録カテゴリ名の集合
    "deadline":   "due_today_or_overdue" | "all" // 期限フィルタ
  },
  "channel": "announce" | "task" | "<channel kind>"  // 送信先 (discord.channel.<kind>_id)
}
```

### フィルタ

- **categories**: `["all"]` で全カテゴリ。それ以外は `tasks.category` (カンマ区切り) に
  いずれかが含まれるタスクだけ。
- **deadline = due_today_or_overdue**: status が `todo`/`doing` (= アクティブ) のうち
  `due_at` がローカル今日の終わり以前 (今日締切 or 期限超過) のものだけ。`all` は期限不問。

### トリガー種別

| type | 発火条件 | dedup |
|------|----------|-------|
| `time` | ローカル時刻が `at` (HH:MM) と一致 | `notify.fired.<id>` = 当日日付 (1日1回) |
| `random` | 当日分の乱数時刻に到達 | 当日プランを `notify.random.<id>.<date>` に保存、 fire 済みフラグ |
| `gps` | 自宅 geofence の inside/outside 遷移 (arrive=外→内, depart=内→外) | 遷移時のみ発火 (状態 `notify.gps.inside`)、 cooldown 10分 |

- **自宅座標** = `weather.fixed_lat`/`weather.fixed_lon` (既存設定を流用)。未設定なら gps トリガーは no-op。
- 距離は haversine。`radius_m` 既定 200m。
- GPS は `gps_locations` の最新行を使う (既存 `readLatestGpsLatLon` と同経路)。

## モジュール (`server/discord/notify/`)

| file | 責務 |
|------|------|
| `types.ts` | NotifyTrigger / TriggerSpec / NotifyFilter 型 |
| `config.ts` | triggers の load/save (app_settings `features.discord.notify.triggers`) |
| `select.ts` | filter → アクティブタスク選択 (category + deadline) |
| `card.ts` | タスク (群) → Discord メッセージ整形 (カード) |
| `geofence.ts` | haversine + 自宅 inside 判定 + 遷移検出 (状態は app_settings) |
| `engine.ts` | fireTrigger(client, db, trigger): select → card → postToChannel |
| `scheduler.ts` | startNotifyScheduler(client, db): time/random/gps の interval 評価 |

Bot の ready 時 (`client.ts`) に `startNotifyScheduler(client, db)` を起動する
(Bot OFF のときは通知も止まる)。

## API (`routes/discord.ts` 追加)

| Verb | Path | 用途 |
|------|------|------|
| GET  | `/api/discord/notify-triggers` | triggers 一覧 + 選択肢 (categories / channel kinds) |
| PUT  | `/api/discord/notify-triggers` | triggers 配列を丸ごと保存 (UI で編集して送る) |
| POST | `/api/discord/notify-triggers/:id/test` | そのトリガーを即時発火 (動作確認) |

## 設定 UI (⚙ 設定 → 🤖 Discord タブ)

「通知トリガー」 サブセクション: トリガー一覧 (有効トグル / 種別 / フィルタ / 送信先) +
追加・編集・削除 + 「テスト送信」。入力 UI は `.foundation-form` 準拠
([[feedback_memoria_foundation_input]])。

## AI カード成形

`message-router.ts` の classify を拡張し `category` / `details` も抽出。
`actions/task.ts` の createTask が category/details を受け、登録後に
`card.ts` の単一タスクカードを reply する。

## 非対象 (この PR では作らない)

- 通知の既読/snooze 管理、 通知履歴 UI。
- GPS の複数地点 geofence (自宅のみ)。
- per-trigger の quiet-hours (グローバルな Bot announce 設定に従う)。
