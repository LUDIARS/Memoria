# gps — 位置情報ログ

## 概要
OwnTracks (HTTP / MQTT) または Legatus (WS subscriber) 経由で受け取る GPS 1 点 = 1 行のログ。 停止区間は始点 + 終点 2 行に圧縮 (samples_count で代表数)。 Tracks タブで地図描画 + decimate / polyline 描画設定。

## ユースケース
- 「軌跡」 タブで日別の移動を地図描画
- 傾向タブの「歩いた距離 / 歩いた時間」 (`trendsGpsWalking`) のソース
- 食事 (`resolveMealLocation`) と作業場所 (`/api/work-sessions`) の場所推定入力
- 場所名解決 (Place API) → `place_name` / `place_address` キャッシュ

## 画面 / 入口
- `📝 ログ` タブ → サブビュー `軌跡` (`tracks`) — `tracks_visible` フラグ ON のとき表示
- ingest key 管理 (Basic auth password 用): 軌跡タブから生成
- WebSocket `/ws/locations` で realtime 描画

## データ
- [gps_locations](../data/gps.md) — recorded_at / lat / lon / accuracy_m / altitude_m / velocity_kmh / course_deg / battery_pct / conn / raw_json / samples_count / place_name / place_address / place_source
- 設定: `app_settings.tracks.decimate_meters` / `tracks.show_polyline` / `locations.ingest_key` / `features.tracks.enabled` / `features.tracks.visible`

## API
- [multi.md](../interface/multi.md) `/api/locations*` 系統:
  - `POST /api/locations/ingest` (1 点投入、 OwnTracks HTTP / 手動)
  - `POST /api/legatus/location-summary` (Legatus 5 分集計、 loopback)
  - `GET /api/locations` `/api/locations/recent` `/api/locations/latest` `/api/locations/days`
  - `DELETE /api/locations?older_than=…` (retention)
  - `POST /api/locations/resolve-all` `/api/locations/compress`
- 設定: `/api/tracks/settings` / `/api/locations/settings*` (ingest key)
- WebSocket: `/ws/locations` (`broadcastLocation`)

## シェア可能か
**local-only**

GPS 軌跡そのものは Hub にシェアできない。 memory `feedback_sensitive_data_via_tailscale.md` のとおり、 GPS は **Tailscale 経由で閉じる** のが推奨経路。 workplace presence (場所名 + 座標スナップショット) は別系統で Hub に行くが、 軌跡そのものは流れない。

## プライバシー観点
- **個人データを保持するテーブル**: `gps_locations` (生活軌跡の連続記録。 個人情報密度最高クラス)。 `raw_json` には OwnTracks の元 payload (TID, BSSID 等) も含まれる。
- **LLM プロバイダに送る情報**: GPS 機能自体は LLM 非依存。 ただし日記生成 (`diary_work` / `diary_highlights`) の prompt に **当日の歩行距離 / 移動時間 / 主要滞在地** が集計値として含まれるため間接的に流れる。 食事の場所推定は LLM ではなく `resolveMealLocation` の DB クエリ。 Place API (Nominatim default) には lat/lng が **third-party HTTPS** で出る (settings で内製 API に置換可能)。
- **共有時に外部に出ない情報**: 軌跡そのもの (lat/lon, 速度, accuracy 等)、 device_id, raw_json。
- **削除時の挙動**: `DELETE /api/locations?older_than=…` で古い行を一括削除 (retention)。 ingest key 認証必須。 圧縮 (`/api/locations/compress`) は中間点を間引いて始点 + 終点の 2 行に集約 (samples_count を更新)。 関連 work_locations / meals は影響なし (lat/lng 経由ではなくスナップショット保持のため)。
