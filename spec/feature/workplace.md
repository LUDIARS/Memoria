# workplace — 作業場所 + presence

## 概要
GPS 座標付きの「作業場所」 (自宅 / コワーキング / カフェ等) をカタログ化し、 GPS チェックインで自動 enter/leave 検出。 オプションで Hub に presence (どこに居るか) をブロードキャスト。

## ユースケース
- 「今日の作業セッション」 を場所別 / 時間別に集計 (`/api/work-sessions`)
- 自宅 = activity_events が無いと non-working 扱い (プライベート時間検出)
- workplace を Hub にシェア (店名 / 住所 / WiFi / 電源タグ等のレビュー的用途)
- presence 共有 → 「今 LUDIARS 仲間が WeWork に居る」 を可視化

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `作業場所` (DATABASE_REDIRECT_TABS に含まれる)
- 詳細モーダル: name / address / lat,lng / tags / shareable
- Place API で逆ジオコード (`/api/work-locations/resolve-place` → Nominatim default)
- チェックイン: `POST /api/work-locations/checkin` (lat/lng → 半径内最近接 → enter/leave)

## データ
- [work_locations](../db/workplace.md) — name / address / latitude / longitude / description / url / tags / shareable / shared_at / owner_user_id
- 集計入力: [gps_locations](../db/gps.md), [activity_events](../db/activity.md)
- 状態: `app_settings.workplace.current.id` / `workplace.current.at` (現在チェックイン中の workplace)

## API
- [workplace.md](../api/workplace.md) — `/api/work-locations*` (CRUD) / `/api/work-locations/resolve-place` / `/api/work-locations/checkin` / `/api/work-sessions` (1 日のセッション検出)
- 関連: [multi.md](../api/multi.md) `/api/multi/share` (kind=work_location)、 Hub への presence は `shareWorkplacePresence` 経由 (multi-client.js)

## シェア可能か
**Hub-shareable** (workplace カタログ自体 + presence の 2 系統)

### workplace カタログのシェア (明示操作)
シェアされるフィールド:

| field | 内容 |
|---|---|
| `name` | 場所名 |
| `address` | 住所 |
| `latitude` / `longitude` | GPS 座標 |
| `description` | 説明 |
| `url` | 公式サイト |
| `tags` | カンマ区切りタグ |

### presence のシェア (チェックイン自動)
`workplace_auto_share_enabled = true` のとき、 enter/leave 時に Hub `/api/shared/workplace-presence` に自動 POST:

| field | 内容 |
|---|---|
| `workplace_name` | 場所名 |
| `address` | 住所 |
| `latitude` / `longitude` | 座標 |
| `kind` | `enter` / `leave` |

経路: いずれも **write-relay-only via Imperativus** (Cernere JWT 必須)。 GPS 軌跡そのものは流れず、 場所名 + 座標のスナップショットだけ。

## プライバシー観点
- **個人データを保持するテーブル**: `work_locations` (生活拠点が直接わかる、 自宅含む)、 `app_settings.workplace.current.*` (現在地)。
- **LLM プロバイダに送る情報**: workplace 機能自体は LLM 非依存。 Place API (Nominatim default) には lat/lng が **third-party HTTPS** で出る点に注意 (`places.api.url` で内製 API に切り替え可能)。
- **共有時に外部に出ない情報**: `shareable=0` の workplace は Hub に出ない。 自宅判定の名前 (`自宅` 含む) のローカル判定ロジック、 滞在時間の分単位集計、 GPS 軌跡そのもの (gps.md 参照)。
- **削除時の挙動**: `DELETE /api/work-locations/:id` で行削除。 GPS 軌跡 / activity_events は影響なし (場所名 lookup ができなくなるだけ)。 Hub にシェア済の場合は残置。
