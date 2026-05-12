# 内蔵 MQTT broker + VPN 経由でモバイル GPS を受け取る

Memoria server (`server/index.ts`) は **MQTT broker (aedes) を内蔵** している。
モバイル (iOS / Android OwnTracks) を VPN 経由でこの broker に publish させると、
**別途 Mosquitto / Legatus 等を入れずに** GPS 軌跡が `gps_locations` に積まれ、
そのまま `/ws/locations` で Tracks UI にもライブ表示される。

```
[ OwnTracks (iPhone) ]
        │  MQTT publish
        │
[ Tailscale tailnet ]            ← 経路を tailnet 内で閉じる
        │
        ▼
[ Memoria server (Windows PC) ]
   :1883  aedes broker  ──▶  gps_locations.insert
                          └▶  /ws/locations broadcast
```

なぜ VPN を強く推奨するか:

- MQTT broker をインターネットに直接晒すと位置情報の宛先と認証鍵が常時露出する。
- Tailscale / Cloudflare WARP / WireGuard 等のオーバレイ VPN を使えば、 broker は
  tailnet の内側にしか居ない (グローバル IP からは到達不能) になり、 認証は
  「tailnet に居る = 信頼」 の単純化が成立する。
- LUDIARS 全体方針: GPS / 長期 WS / MQTT 等のセンシティブな常時接続は Tailscale
  経由が既定 (`feedback_sensitive_data_via_tailscale.md`)。

## 1. broker を有効化

特に何もしなくても、 Memoria server 起動時に broker が `0.0.0.0:1883` で
listen し始める。 認証なしの初期状態は **VPN 内で閉じている前提** なので、
インターネットに開いてはいけない。

`.env`:

```env
# 既定値で十分。 必要に応じて bind / port / 認証を絞る。
# MEMORIA_MQTT_BROKER=off                 # broker を完全停止 (Legatus 経路に戻すとき等)
# MEMORIA_MQTT_BROKER_PORT=1883
# MEMORIA_MQTT_BROKER_HOST=0.0.0.0        # tailnet 内に閉じたいなら '127.0.0.1' or tailnet IP
# MEMORIA_MQTT_USERNAME=memoria
# MEMORIA_MQTT_PASSWORD=<openssl rand -base64 24 等>
# MEMORIA_MQTT_TOPIC=owntracks/+/+        # publish が来てほしい topic 形式
```

bind host を `127.0.0.1` にすると **同じ PC 内** からしか叩けなくなるので、
モバイルから受けたい場合は `0.0.0.0` (全 NIC) か tailnet IP を指定する。

## 2. Tailscale を入れる (推奨)

[Tailscale](https://tailscale.com/) は Wireguard ベースのオーバレイ VPN。 個人
利用は free plan で十分。

1. PC (Memoria server を動かす Windows) に Tailscale をインストール → `tailscale up`
2. 同じアカウントで iPhone / Android にも Tailscale を入れる
3. PC の tailnet 上の IP を確認: `tailscale ip -4` (例 `100.x.y.z`)

これだけで、 モバイル → PC は `100.x.y.z:1883` で到達できる (グローバル IP は
一切要らない)。

## 3. OwnTracks の設定

### iOS / Android

| 項目 | 値 |
| --- | --- |
| Mode | MQTT (Private) |
| Host | PC の tailnet IP (例 `100.x.y.z`) |
| Port | `1883` |
| TLS | OFF (tailnet 内で暗号化されるので不要) |
| User | `MEMORIA_MQTT_USERNAME` を設定した場合のみ |
| Password | `MEMORIA_MQTT_PASSWORD` を設定した場合のみ |
| Client ID | 端末固有の任意の値 |
| Device ID | 任意。 `iphone` / `android` 等 (Memoria の `device_id` 列に入る) |
| Track ID | 2 文字 (`iP` 等) |
| Topic | `owntracks/<user>/<device>` (例 `owntracks/me/iphone`) — OwnTracks 既定でも OK |

> Tailscale を経由するので **必ず tailnet IP を指定**。 ルータの LAN IP
> (192.168.x.x) や グローバル IP を入れない。

### 動作確認

PC 側で:

```bash
# 起動ログに broker の listen が出る
[mqtt-broker] listening on mqtt://0.0.0.0:1883 (no-auth, topic=owntracks/+/+)

# モバイル側で OwnTracks 「Send Now」 を叩くと:
[mqtt-broker] client connected: <client_id>
[mqtt-broker] insert id=1234 iphone (35.66042, 139.69828)
```

Tracks UI (http://localhost:5180/) でも、 新着点がリアルタイムに地図に追加される。

## 4. Legatus との関係

旧経路: Legatus (loopback 17320 WS) が OwnTracks を MQTT で受けて、 Memoria は
それを WS subscribe する。 「PC 常駐の代理人」 として OwnTracks 受信を肩代わり
していた。

内蔵 broker が直接 OwnTracks を受けるようになったので、 Legatus を経由する
必要は無くなった。 既定では Legatus subscriber は **off**。 引き続き Legatus
を中継として使いたい場合は `MEMORIA_LEGATUS_WS=on` で明示的に opt-in する。

```env
MEMORIA_LEGATUS_WS=on   # legacy 経路を併用する場合のみ
```

## 5. インターネット経由で動かしたい場合 (非推奨)

VPN を使えない環境向けの fallback。 セキュリティ面で大きく不利になるので、
原則として避ける。

- broker port (1883) をルータでポートフォワードする
- `.env` で **必ず** `MEMORIA_MQTT_USERNAME` / `MEMORIA_MQTT_PASSWORD` を設定
- 可能なら TLS (8883) でラップする (リバースプロキシ + mqtts、 もしくは Caddy
  + tcp_proxy)。 aedes 直接の TLS 化は対応していないので、 Caddy / nginx-stream
  経由が現実的

→ それでも盗聴 / DDoS / port scan の対象になり続けるので、 強く Tailscale を
推奨する。

## 6. トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| `[mqtt-broker] listening on mqtt://...` が出ない | `MEMORIA_MQTT_BROKER=off` が設定されている / port (1883) が他プロセスに占有されている (`netstat -ano | findstr 1883`) |
| モバイルから繋がらない | `MEMORIA_MQTT_BROKER_HOST=127.0.0.1` になっていないか / Windows Firewall で 1883 が in-bound 拒否になっていないか / tailnet IP を OwnTracks に入れているか |
| 接続はできるが gps_locations に入らない | topic が `owntracks/<user>/<device>` の 3 セグメントになっているか (OwnTracks の "Auto topic" を ON にすると自動で合う) / payload が `_type=location` の JSON か |
| `client error: ... bad credentials` | `MEMORIA_MQTT_USERNAME` / `MEMORIA_MQTT_PASSWORD` と OwnTracks 側の User / Password が一致していない |
