# Memoria セットアップ — 用途別ガイド

Memoria は多機能 (ブクマ + Dig + 辞書 + 日記 + ドメイン辞書 + 多 LLM + GPS/MQTT +
WebPush + Hub 共有 + Electron) なので、 **「何をしたいか」 から逆引き** できるように
設定ガイドを用途別に分けている。 各ガイドは目的 → 設定キー (config/env 表) → 手順 →
注意点 → トラブルシュート の順。

全 env/config キーの正本一覧は [`config-reference.md`](./config-reference.md)。

---

## 用途別インデックス (○○するための設定)

| やりたいこと | ガイド | キモになる設定 |
|---|---|---|
| とにかくローカルで動かす | [`local-startup.md`](./local-startup.md) | `MEMORIA_PORT` / `MEMORIA_DATA` / `MEMORIA_CLAUDE_BIN` / `CLAUDE_CODE_GIT_BASH_PATH` |
| 要約 / Dig / 日記の AI を選ぶ | [`llm-providers.md`](./llm-providers.md) | `llm.<task>.provider` / `llm.openai.api_key` (app_settings) |
| スマホへ通知を飛ばす | [`webpush.md`](./webpush.md) | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (既定は自動生成) |
| GPS 軌跡 / 作業場所を取り込む | [`location-tracking.md`](./location-tracking.md) | `MEMORIA_MQTT_BROKER*` / `LOCATIONS_INGEST_KEY` / `MEMORIA_PLACES_API_KEY` / `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` |
| 複数ユーザで辞書 / dig / ブクマを共有 (Hub) | [`hub.md`](./hub.md) | `CERNERE_*` / `MEMORIA_PG_URL` / `MEMORIA_HUB_*` (server/multi/) |

ガイドにない「鍵を入れる / hook を入れる」 系の手作業一覧は
[`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md)。

---

## 最短起動 (3 行)

```bash
cd server
npm install
npm start          # → http://localhost:5180/
```

env は **基本いらない**。 LLM / GitHub PAT / Steam / OwnTracks key 等は起動後の
画面 (⚙ AI / 🔌 連携) から入れる。 ポートとデータ保存先だけは起動前に決まるので、
変えたいときだけ env で渡す ([`local-startup.md`](./local-startup.md))。

ふつうのユーザは server 直起動ではなく **デスクトップアプリ (Electron)** で完結する
(サーバも Node も同梱、 設定は全部アプリ内 UI)。 詳しくは
[`../../README.md`](../../README.md) の「A. デスクトップアプリ」。

---

## 設定の優先順位 (config / env の解決順)

Memoria の設定値は **2 系統** ある。 どちらに書いても良いキーは原則
**UI (app_settings) が env より優先** される。

### 1. UI 設定 (app_settings — SQLite に保存)

起動後の画面から入れる値はすべて SQLite の `app_settings` テーブルに入り、
再起動しても残る。 ここに値があれば env より優先される。

- LLM プロバイダ / OpenAI key / CLI パス … `llm.*` / `runtime.git_bash_path`
  (`server/llm.ts:124-143`)
- Maps API key … `maps.api_key` (`server/routes/config.ts:306`)
- locations ingest key … `locations.ingest_key` (`server/lib/ingest-auth.ts:32-36`)
- Discord bot token / 設定 … `features.discord.*` (`server/discord/settings.ts`)
- GitHub PAT / user … `diary_settings` (`server/routes/diary.ts:38-39`)

### 2. 環境変数 (env)

起動前にしか決まらない値 (port / data dir) と、 CI / CLI / ヘッドレス運用で
UI を経由せず流し込みたい値はここ。

代表的な解決順 (実装で確認できたもの):

| 値 | 解決順 (先勝ち) | 根拠 |
|---|---|---|
| LLM 各種 | app_settings (`llm.*`) → 既定値。 `git_bash_path` のみ app_settings → `CLAUDE_CODE_GIT_BASH_PATH` → 空 | `server/llm.ts:135-142` |
| Maps key (SPA 用) | app_settings `maps.api_key` → `GOOGLE_MAPS_API_KEY` | `server/routes/config.ts:306` |
| Places key (server 側) | `MEMORIA_PLACES_API_KEY` → `GOOGLE_MAPS_API_KEY` → app_settings `maps.api_key` | `server/lib/place-resolver.ts:100-104` |
| locations ingest key | app_settings `locations.ingest_key` → `LOCATIONS_INGEST_KEY` → 空 (= 認証無効) | `server/lib/ingest-auth.ts:32-36` |
| Discord bot token | app_settings `features.discord.bot_token` → `MEMORIA_DISCORD_BOT_TOKEN` | `server/discord/settings.ts:42-48` |
| GitHub PAT / user | diary_settings → `MEMORIA_GH_TOKEN` / `MEMORIA_GH_USER` | `server/routes/diary.ts:38-39` |
| VAPID 鍵 | `VAPID_PUBLIC_KEY`+`VAPID_PRIVATE_KEY` → `<dataDir>/vapid.json` → 自動生成 | `server/push.ts:45-62` |

> Places key だけは「env が先、 app_settings が後」 になっている。 これは
> SPA 用の `maps.api_key` (Referer 制限あり) で server-side の Geocoding/Places を
> 叩くと `REQUEST_DENIED` になるため、 server 専用キーを env 側に置けるようにした
> ため (`server/lib/place-resolver.ts:88-99`)。

### .env ファイルについて

`npm start` / `npm run dev` は `tsx --env-file-if-exists=.env.secrets` で起動する
(`server/package.json:8-10`)。 つまり読み込まれる env ファイルは **`server/.env.secrets`**
のみ。 ここは Infisical の machine identity (`INFISICAL_*`) を置く想定で、 通常の
ローカル運用では空でよい (`server/bootstrap.ts` は Infisical を使わない)。 任意の
env を恒久的に渡したい場合は shell の export か `server/.env.secrets` に書く。

---

## 個人データの扱い (前提)

- 個人データ (GPS / 日記 / 履歴) は **手元の SQLite に閉じる** のが既定。
  外に出るのは Hub に明示的に「シェア」 したエントリ (辞書 / dig / ブクマ) だけ
  ([`../../README.md`](../../README.md) の C 章)。
- 認証 / 共有まわりを設定するときも、 個人ライフログを LUDIARS 共有 DB や外部 API に
  流す構成は作らない (`CLAUDE.md` の「個人データ」 節)。

---

## 関連設計ドキュメント

| ドキュメント | 内容 |
|---|---|
| [`../../README.md`](../../README.md) | 3 つの動かし方 (Desktop / server / Hub) + 機能一覧 + env 表 |
| [`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md) | ユーザが手で入れる鍵 / hook の一覧 |
| [`../../docs/setup/git-hooks.md`](../../docs/setup/git-hooks.md) | git post-commit hook の導入 |
| [`../../docs/mqtt-vpn-setup.md`](../../docs/mqtt-vpn-setup.md) | OwnTracks → 内蔵 MQTT broker (VPN) |
| [`../../docs/mobile-share.md`](../../docs/mobile-share.md) | PWA share_target / iOS Shortcut |
| [`../../docs/multi-server-architecture.md`](../../docs/multi-server-architecture.md) | Memoria Hub のアーキテクチャ |
| [`../../server/multi/README.md`](../../server/multi/README.md) | Hub 構築 + Cernere OAuth ランブック |
