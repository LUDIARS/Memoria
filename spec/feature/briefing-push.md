# 定期ブリーフィング Push (briefing)

Memoria が保持/取得できる「今すぐ役立つ情報」 を一定間隔でまとめ、 Discord
(#briefing) と Hora (デスクトップおじさん) に投稿する機能。

## 目的

朝〜夜の活動時間帯に、 次の情報を 1 通のブリーフィングとして定期 Push する:

1. **運行情報** — 鉄道遅延 (対象路線のみ)
2. **これから3時間の天気** — hourly 予報
3. **現在地の天気** — current
4. **直近◯分のニュース** — RSS の新着 (fetched_at ベース)
5. **今日のタスク** — todo / doing
6. **空気質・紫外線** — PM2.5 / AQI / UV (花粉は取得できれば)
7. **防災** — 気象警報・注意報 + 直近の地震

## アーキテクチャ

`server/briefing/` ドメイン。 ソース層は「取得 + 整形」 だけを担い、 送信先を知らない (SRP)。

```
briefing/
  config.ts          app_settings の briefing.* を BriefingConfig へ正規化
  types.ts           SectionBlock / Briefing
  sources/
    train.ts         rti-giken delay.json を路線フィルタ
    weather.ts       lib/weather.ts の Forecast から「3h」「現在地」 2 ブロック
    environment.ts   Open-Meteo Air Quality API (PM2.5/AQI/UV/花粉)
    news.ts          rss listArticlesSinceMinutes
    tasks.ts         db listTasks (todo/doing)
    disaster.ts      P2P地震 + 気象庁 警報JSON
  compose.ts         位置解決 → 有効セクションを並列収集 → Briefing
  format.ts          formatForDiscord (分割) / formatForHora (平文)
  hora.ts            Hora ローカル HTTP へ POST
  scheduler.ts       1分tick + lastRun ガード、 稼働時間帯のみ
  index.ts           バレル
```

配線:
- `discord/` に `briefing` channel kind + `postBriefingToDiscord` / `discordClientReady` seam
- `rss/store.ts` に `listArticlesSinceMinutes`
- `lib/scheduler.ts` の `startSchedulers` から `startBriefingScheduler(db)` を起動
- `routes/briefing.ts`: `GET /api/briefing/preview` (送らず組み立て結果)、 `POST /api/briefing/test` (即時送信)

## 外部 API (いずれも無料・APIキー不要)

| 用途 | エンドポイント | 備考 |
|---|---|---|
| 運行情報 | `https://tetsudo.rti-giken.jp/free/delay.json` | 全国・遅延路線のみ返る。 平常路線は配列に無い |
| 天気 | Open-Meteo forecast (既存 lib/weather.ts 流用) | |
| 空気質/UV | `https://air-quality-api.open-meteo.com/v1/air-quality` | 花粉は欧州ドメインのみ→日本では null |
| 地震 | `https://api.p2pquake.net/v2/history?codes=551` | maxScale=10×震度 |
| 気象警報 | `https://www.jma.go.jp/bosai/warning/data/warning/<area>.json` | area 未設定なら省略 |

## 設定キー (app_settings)

| key | 既定 | 説明 |
|---|---|---|
| `briefing.enabled` | true | 機能マスタ |
| `briefing.interval_minutes` | 30 | 投稿間隔 (最小5) |
| `briefing.active_start_hour` / `briefing.active_end_hour` | 6 / 23 | 稼働時間帯 [start,end) |
| `briefing.discord` | true | #briefing へ投稿 |
| `briefing.hora.enabled` | false | Hora へ投稿 |
| `briefing.hora.url` | `http://127.0.0.1:5179/api/say` | Hora 受信 URL |
| `briefing.section.{train,weather,news,tasks,environment,disaster}` | true | セクション個別 ON/OFF |
| `briefing.train.lines` | (空) | 対象路線名 (カンマ区切り、部分一致)。 **要設定** |
| `briefing.news_window_minutes` | =interval | 「直近◯分」 |
| `briefing.disaster.jma_area_code` | (空) | 気象警報エリア (例 130000=東京) |
| `briefing.disaster.eq_min_scale` | 30 | 地震の最小震度スケール (30=震度3) |
| `weather.fixed_lat` / `weather.fixed_lon` | — | 位置 (無ければ GPS 最新点) |

`features.discord.briefing` (既定 true) で #briefing チャンネル生成を制御。

## 送信先と安全性

- スケジューラは「送信先が無い (Discord未起動 かつ Hora無効)」 なら組み立てもしない (外部API無駄叩き防止)。
- Discord 投稿は Bot 未起動なら no-op。 Hora 投稿は受信側未対応でも no-op (best-effort)。
- 各ソースは自前で例外を握り、 失敗は「⚠️ 取得失敗」 の 1 行に縮退 → 1 ソースの失敗が全体を止めない。

## Hora 連携

Hora 側はローカル HTTP listener (`POST /api/say`) を新設してブリーフィング本文を
受け取り、 おじさんに喋らせる (Hora リポの別 PR)。 payload:

```json
{ "source": "memoria-briefing", "kind": "briefing", "text": "..." }
```

## 残課題

- 路線名フィルタの精度 (delay.json の `name` 表記揺れ)。 運用後に調整。
- 気象警報のコード→名称テーブルが部分的 (主要コードのみ)。
- 設定 UI (現状は app_settings 直編集 / API)。
- Hora 受信側の実装 (別 PR)。
