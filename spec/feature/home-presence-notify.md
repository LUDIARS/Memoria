# 帰宅・出発通知 (home-presence)

2026-10-13 起草。 neco 指示:

> Memoria に家の近くに来たよね通知と家出発したよね通知を実装する話が初期にあったんだけど結局やってないのでやりたい
> トリガーにして買い物などの通知を仕掛ける / LINE に投稿できるようにする
> (方式) 専用の通知として作り直す

## 目的

自宅との位置関係が変わった瞬間 (近くに来た / 着いた / 出た) を**トリガー**にして、
場面に合った一言と、条件に合うタスク (例: 買い物カテゴリ) を通知する。
送り先は Discord と LINE を選べる。

旧実装 ([discord-task-notify](./discord-task-notify.md) の `gps` トリガー) は
Discord Bot の中にあり、 半径 1 段の内外判定・古い GPS でも判定・送り先 Discord のみ、
だったため置き換える。

## 用語

| 語 | 意味 |
|----|------|
| zone | 自宅に対する現在地の区分。 `home` (自宅半径内) / `near` (近く半径内) / `away` (それより外) |
| event | zone 遷移から作る出来事。 `approach` (近くに来た) / `arrive` (着いた) / `depart` (出発した) |
| rule | event に反応して通知する設定 1 件。 一言 + タスク条件 + 送り先 |
| sink | 送り先の実装 (`discord` / `line`)。 共通 interface で差し替え可能 |

## 自宅の決め方

1. `work_locations` の `is_home=1` で緯度経度があるもの (半径 = `radius_m`、 未設定なら 150m)。
2. 無ければ天気の固定座標 `weather.fixed_lat/lon` (半径 200m、 旧実装と同じ)。
3. どちらも無ければ判定しない (通知は出ない、 UI に「自宅未設定」 と出す)。

## zone 判定 (ヒステリシス付き)

距離 `d` = 最新 GPS と自宅の haversine 距離。 `H` = ヒステリシス (既定 50m)。

- 前回 `home`: `d > homeR + H` で外へ出た扱い。 そうでなければ `home` のまま。
- 前回 `near`: `d <= homeR` で `home`、 `d > nearR + H` で `away`、 それ以外 `near`。
- 前回 `away` / 不明: `d <= homeR` で `home`、 `d <= nearR` で `near`、 それ以外 `away`。
- 外へ出た後の判定は `d <= nearR + H` を `near` とみなす (境界の行き来で approach を連発しない)。

`nearR` 既定 1000m (UI で 300〜5000m)。

## event 生成

| 前回 → 今回 | event |
|------------|-------|
| away → near | approach |
| away → home | arrive (approach は飛ばす) |
| near → home | arrive |
| home → near / away | depart |
| near → away | なし (近くを通り過ぎただけ) |
| 初回 (状態なし) | なし (基準だけ保存、 再起動直後の誤発火防止) |

- **鮮度**: 最新 GPS の `recorded_at` が `staleMin` (既定 15 分) より古ければ判定しない (状態も更新しない)。
  端末からの送信が止まって古い位置で誤判定するのを防ぐ。
- **cooldown**: 同じ event は前回発火から `cooldownMin` (既定 10 分) 以内なら出さない (状態は更新する)。
- 状態は `app_settings` `features.home_presence.state` に JSON (`zone` / `lastEventAt{}`) で保持する。

## rule

```jsonc
{
  "id": "uuid",
  "name": "出発したら買い物",
  "enabled": true,
  "event": "approach" | "arrive" | "depart",
  "message": "家出発したよね",             // 空なら event ごとの既定文
  "includeTasks": true,                    // タスク一覧を添える
  "filter": { "categories": ["買い物"], "deadline": "all" | "due_today_or_overdue" },
  "sendWhenEmpty": false,                  // 該当タスク 0 件でも一言を送るか
  "destinations": [ { "kind": "discord", "channel": "announce" }, { "kind": "line" } ]
}
```

既定文: approach「🏠 家の近くに来たよね」 / arrive「🏠 おかえり、家に着いたね」 / depart「🚪 家出発したよね」。

## 送り先 (sink)

`server/shared/notify-sink.ts` に登録式の interface を置く。 home-presence は送り先の実装を知らない。

- `discord`: Discord Bot の ready 時に discord ドメインが登録する。 target = channel kind。 Bot 停止中は送れない (失敗をログ)。
- `line`: LINE Messaging API の push (`POST https://api.line.me/v2/bot/message/push`)。
  - 設定: チャネルアクセストークン (長期) と 送り先 ID (ユーザー ID `U...` / グループ ID `C...`)。
    `app_settings` に保存し、 GET API は `token_set` の真偽だけ返す (Discord Bot token と同じ扱い)。
  - LINE Notify は 2025-03-31 に終了しているので使わない。
  - 送る内容は外部サービス (LINE) へ出る。 設定した時だけ送る opt-in。

## 判定の回し方

`startHomePresenceScheduler(db)` を Memoria 起動時に開始し、 60 秒ごとに評価する。
Discord Bot の ON/OFF とは独立 (LINE だけでも動く)。 マスタ `features.home_presence.enabled` が OFF なら何もしない。

GPS の取り込み口は 7 か所 (OwnTracks / MQTT / Wi-Fi / Legatus / HTTP 等) あるので、
取り込み側には手を入れず最新行を読む方式にする。

## 旧 `gps` トリガーの移行

- 起動時に Discord 通知トリガーの `gps` 種別を home-presence の rule に 1 回だけ変換して移す
  (`arrive`→`arrive`, `depart`→`depart`, filter と channel を引き継ぐ。 半径は自宅半径として使わない)。
- 変換後、 Discord 通知トリガーから `gps` 種別を取り除く (UI の選択肢からも消す)。
- `server/discord/notify/geofence.ts` と `gpsTick` は削除する。

## モジュール

| file | 責務 |
|------|------|
| `server/shared/notify-sink.ts` | sink の登録と送信 (kind → 送信関数) |
| `server/shared/task-select.ts` | filter → アクティブタスク選択 (discord/notify/select.ts から移動、 両ドメインで共用) |
| `server/home-presence/types.ts` | Zone / PresenceEvent / Rule / Config 型 |
| `server/home-presence/config.ts` | config・rule の load/save/正規化 |
| `server/home-presence/home.ts` | 自宅座標と半径の解決 |
| `server/home-presence/zone.ts` | 距離計算と zone 判定 (純関数) |
| `server/home-presence/detect.ts` | zone 遷移 → event (純関数、 cooldown 含む) |
| `server/home-presence/state.ts` | 判定状態の永続化 |
| `server/home-presence/latest-fix.ts` | 最新 GPS と鮮度判定 (精度 300m 超の点は使わない) |
| `server/home-presence/evaluate.ts` | 1 回分の評価 (自宅・最新 GPS・前回状態 → event、 状態保存) |
| `server/home-presence/message.ts` | 一言 + タスク一覧の文面 |
| `server/home-presence/engine.ts` | event → rule 選択 → sink 送信 |
| `server/home-presence/scheduler.ts` | 60 秒ごとの評価 |
| `server/home-presence/migrate-gps-triggers.ts` | 旧 gps トリガーの移行 |
| `server/line/settings.ts` | LINE 設定 (token / 送り先) |
| `server/line/client.ts` | push API 呼び出し |
| `server/line/sink.ts` | `line` sink の登録 |
| `server/discord/sink.ts` | `discord` sink の登録 (Bot ready で登録、 停止で解除) |
| `server/routes/home-presence.ts` | 設定・状態・テスト送信 API |
| `server/routes/line.ts` | LINE 設定・テスト送信 API |
| `server/public/src/home-presence-view.ts` | 設定タブ 「🏠 帰宅・出発 / LINE」 |

## API (admin scope)

| Verb | Path | 用途 |
|------|------|------|
| GET | `/api/home-presence` | config + rules + 状態 (自宅の出所・半径・現在 zone・最新 GPS の経過分。 座標そのものは返さない) |
| PUT | `/api/home-presence` | config + rules を保存 |
| POST | `/api/home-presence/rules/:id/test` | その rule を即時送信 (0 件でも送る) |
| GET | `/api/line/settings` | `{ token_set, to }` |
| PUT | `/api/line/settings` | token (空文字で据え置き) / to を保存 |
| POST | `/api/line/test` | テスト文を送る |

## 非対象

- 自宅以外の地点 (職場・スーパー) の geofence。
- LINE の webhook (グループ ID の自動取得、 返信での操作)。 ID は LINE Developers コンソールで確認して入力する。
- Web プッシュへの送信 (sink を足せば載るが、 今回は Discord / LINE のみ)。
