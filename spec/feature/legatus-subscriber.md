# legatus-subscriber — Legatus 経由の OwnTracks → Memoria 転送

## 概要
同じ PC (loopback 17320) で動く Legatus が OwnTracks → MQTT 経由で受け取った GPS イベントを `/ws` で broadcast する。 Memoria はそれを WebSocket で subscribe して `gps_locations` に即時 insert + Tracks UI へリアルタイム描画。

## ユースケース
- iPhone OwnTracks → MQTT → Legatus → Memoria の細かい軌跡を遅延ゼロで描画
- 直接 HTTP ingest (`/api/locations/ingest`) と並行運用 (どっちも同じ DB に入る)
- Legatus 側 summary (5 分集計の `/api/legatus/location-summary`) は別経路 (start/end 2 点のみ)

## 画面 / 入口
- ユーザ操作なし (起動時に自動 connect)。 `MEMORIA_LEGATUS_WS_URL` 環境変数で接続先変更可
- `📝 ログ` → `軌跡` で結果を視認

## データ
- [gps_locations](../db/gps.md) — `raw_json` に `{via: 'legatus-ws', topic_user, device}` を埋め込んで識別

## API
- 受信側: `ws://127.0.0.1:17320/ws` (Legatus が listen) を Memoria が subscribe
- 出力: 内部的に `insertGpsLocation` 呼び出し → `broadcastLocation` で Memoria の `/ws/locations` に転送 → Tracks UI に realtime 描画

## シェア可能か
**local-only**

転送機能自体には共有経路なし。 GPS データ ([gps.md](gps.md)) と同じく Hub には流さない。

## プライバシー観点
- **個人データを保持するテーブル**: GPS データを `gps_locations` に書くため [gps.md](gps.md) と同等の機微度。
- **LLM プロバイダに送る情報**: 直接送信しない。
- **共有時に外部に出ない情報**: Legatus との接続自体が **loopback / tailnet 内** で完結する想定 (memory `feedback_sensitive_data_via_tailscale.md`)。 Cloudflare Tunnel は UDP 通さないので OwnTracks に不向き (`feedback_cloudflare_tunnel_udp.md`)。
- **削除時の挙動**: subscriber 自身は state を持たない。 切断時は exponential backoff で再接続 (1s → 30s 上限)。 GPS 行の retention は [gps.md](gps.md) 側の `DELETE /api/locations`。
