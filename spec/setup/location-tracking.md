# GPS 軌跡 / 作業場所を取り込むための設定

## 目的

スマホ (OwnTracks) の GPS / PC の WiFi スキャンから位置を取り込み、 軌跡 +
作業場所 (ジオフェンス) を記録する。 取り込み経路は 3 つ:

1. **内蔵 MQTT broker** — OwnTracks を VPN 経由で Memoria に直接 publish (既定)
2. **HTTP ingest** — OwnTracks HTTP モード等で `/api/locations/ingest` に POST
3. **PC WiFi → Google Geolocation** — モバイルが無い時間帯の PC 位置推定 (Windows)

場所名の解決 (逆ジオコーディング) には Google Maps / Places の server-side key を使う。

## 経路ごとの設定キー

### 1. 内蔵 MQTT broker (OwnTracks 直接受信)

外部 Mosquitto を立てずに OwnTracks を直接受ける既定経路。 受信 →
`gps_locations` insert → `/ws/locations` broadcast まで 1 process で完結
(`server/index.ts:449-465` / broker は `server/mqtt/broker.ts`)。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| broker 有効/停止 | `MEMORIA_MQTT_BROKER` | (起動) | `off` で内蔵 broker を完全停止 | `server/mqtt/broker.ts:24,76` |
| broker TCP port | `MEMORIA_MQTT_BROKER_PORT` | `1883` | broker の listen port | `server/mqtt/broker.ts:25,78` |
| bind host | `MEMORIA_MQTT_BROKER_HOST` | `0.0.0.0` | tailnet/loopback に絞るなら `127.0.0.1` 等 | `server/mqtt/broker.ts:26,79` |
| publish 認証 user | `MEMORIA_MQTT_USERNAME` | (無し) | username/password **両方** 設定で認証有効化 | `server/mqtt/broker.ts:27,80` |
| publish 認証 pass | `MEMORIA_MQTT_PASSWORD` | (無し) | 同上 | `server/mqtt/broker.ts:28,81` |

セットアップ手順は [`../../docs/mqtt-vpn-setup.md`](../../docs/mqtt-vpn-setup.md)。

### 2. HTTP ingest (`/api/locations/ingest`)

LAN 開放 / Cloudflare Tunnel 公開時に保護するための API key (`server/lib/ingest-auth.ts`)。

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| ingest key | app_settings `locations.ingest_key` → env `LOCATIONS_INGEST_KEY` | (空 = 認証無効) | UI 生成が優先。 空ならローカル/LAN-only バインド前提で認証なし | `server/lib/ingest-auth.ts:5-36` |

認証ヘッダは 3 通りいずれか一致で OK: `X-Memoria-Ingest-Key` / `Authorization: Bearer` /
`Authorization: Basic base64(u:<key>)` (OwnTracks iOS HTTP モード用 /
`server/lib/ingest-auth.ts:38-65`)。

### 3. PC WiFi → 位置情報 (Windows 限定)

モバイルが手元に無くても PC の BSSID 群から概略位置を推定して `gps_locations` に積む
(`server/wifi-location.ts` / `server/index.ts:475-488`)。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| Geolocation key | `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` | (無し = 無効) | 未設定 / Windows 以外なら自動 disable | `server/wifi-location.ts:18,64-66` |
| 実行間隔 (秒) | `MEMORIA_WIFI_INTERVAL_SEC` | `600` | 最小 60 秒 | `server/wifi-location.ts:19,74` |

### 場所名の解決 (逆ジオコーディング)

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| Maps/Places key | app_settings `maps.api_key` (設定 UI、 env からは読まない) | (無し) | Maps JS + server-side Geocoding/Places で共用。 server-side 呼び出しがあるので Referer 制限なし (or IP 制限) の key を入れる | `server/lib/place-resolver.ts:88-104` / `server/routes/config.ts:306` |

## 手順

1. **OwnTracks (推奨)**: スマホに OwnTracks を入れ、 Tailscale 等の VPN で
   PC に到達させ、 内蔵 broker (`<PC>:1883`) に publish 設定。 認証を付けるなら
   `MEMORIA_MQTT_USERNAME` / `MEMORIA_MQTT_PASSWORD` を両方 env で設定。 詳細は
   [`../../docs/mqtt-vpn-setup.md`](../../docs/mqtt-vpn-setup.md)。
2. **HTTP モード**を使うなら、 軌跡タブ → 🔑 key で `locations.ingest_key` を生成し
   (`server/routes/config.ts:320-` の regenerate)、 OwnTracks の Basic auth に入れる。
3. **PC WiFi 位置**を使うなら `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` を env に設定
   (Windows のみ)。
4. **場所名表示**には Cloud Console で Places API (New) + Geocoding API を有効化した
   Referer 制限なし (or IP 制限) の key を、 設定 UI (設定 → AI / 連携 → Maps API key)
   から `maps.api_key` に保存する (env では設定しない)。

## 注意点

- **broker の bind host に注意**。 既定 `0.0.0.0` は全 NIC で待ち受ける。 WAN に
  晒さないよう tailnet IP / `127.0.0.1` に絞るか、 必ず username/password を設定する
  (`server/mqtt/broker.ts:26`)。 WAN 公開時は TLS + 認証必須。
- **ingest key を空のまま LAN/WAN に晒さない**。 空 = 認証無効なので、 ローカル
  バインド以外で開けるなら必ず `locations.ingest_key` を生成する
  (`server/lib/ingest-auth.ts:5-7`)。
- **Maps/Places key は Referer 制限なしにする**。 key は `maps.api_key` 一本で Maps JS と
  server-side Geocoding/Places を共用するため、 Referer 制限ありの Maps JS 用 key を入れると
  server-side 呼び出しが `Requests from referer <empty> are blocked.` (403) で弾かれる。
  Referer 制限なし (or IP 制限) + Places API (New) + Geocoding API 有効化の key を入れる
  (`server/lib/place-resolver.ts:88-99`)。
- **Iv (Imperativus) の Mosquitto と port が衝突**しうる。 リポ同梱の
  `docker-compose.yml` は外部 mosquitto を立てる場合に host port を 1884/9002 に
  ずらしている (内蔵 broker を使う既定運用ではそもそも mosquitto は不要)。
- **Legatus 経由は旧経路**。 内蔵 broker が OwnTracks を直接受けるので既定 off。
  互換のため `MEMORIA_LEGATUS_WS=on` で opt-in できる (`server/index.ts:490-506`)。
- 位置データは個人ライフログなので **ローカル SQLite に閉じる**。 Hub にシェアするのは
  辞書 / dig / ブクマ等のナレッジだけ ([`README.md`](./README.md) の個人データ節)。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| OwnTracks が繋がらない | broker bind host / port / VPN 到達性を確認。 認証付きなら user/pass 両方 |
| ingest が 401 | `locations.ingest_key` 設定済なのに key 不一致。 ヘッダ形式 (Bearer/Basic/X-) を確認 |
| 場所名が出ない / REQUEST_DENIED / referer blocked | 設定 UI の `maps.api_key` に Referer 制限なし key を。 Places API (New) + Geocoding API 有効化を確認 |
| WiFi 位置が動かない | Windows 以外 or `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` 未設定 → 自動 disable |
| broker を止めたい | `MEMORIA_MQTT_BROKER=off` |

## 関連

- [`README.md`](./README.md) — 設定の優先順位
- [`config-reference.md`](./config-reference.md) — 全キー一覧
- [`../../docs/mqtt-vpn-setup.md`](../../docs/mqtt-vpn-setup.md) — OwnTracks → 内蔵 broker (VPN)
- [`../../docs/mobile-share.md`](../../docs/mobile-share.md) — スマホからの保存 (PWA / Shortcut)
- [`../api/visit.md`](../interface/visit.md) — locations / visit API 仕様
