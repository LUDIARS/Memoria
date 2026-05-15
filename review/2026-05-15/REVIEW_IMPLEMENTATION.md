# 実装評価 (Implementation Evaluation)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Memoria |
| 対象ブランチ / PR | main (Phase 6 multi-hub + weather/transit) |
| レビュー実施日 | 2026-05-15 |
| 対象コミット範囲 | 678bbb1..HEAD |

---

## 1. コード品質 (Code Quality)

| 該当箇所 | 問題分類 | 説明 | 推奨修正 |
|----------|---------|------|---------|
| server/bootstrap.ts | 例外の握りつぶし | app_settings 読込失敗時に `console.warn` で log するのみ | error 詳細を console.error に上げる |
| server/index.ts (複数) | マジックナンバー | pending job re-queue / station seed 等で hardcoded count/timeout | constants を module top に define |
| server/lib/transit-detect.ts:37-40 | マジックナンバー | MIN_TRAVEL_SPEED (25 km/h) / MIN_TRAVEL_MS (3 min) | constants として define 済み (OK) |
| server/lib/weather.ts:74 | 暗黙的型変換 | `const raw = await res.json() as OpenMeteoResponse` | OpenMeteoResponse interface を exhaustive に validate |
| server/local/multi-proxy.ts:30-56 | DRY 違反 | regex pattern matching が冗長 | 7 型の path mapping を configurable table に変更 |

---

## 2. データスキーマの妥当性・重複確認 (Data Schema Validation)

| テーブル / モデル | 問題種別 | 説明 | 推奨対応 |
|-----------------|---------|------|---------|
| app_settings | 正規化不足 | infisical.* 等 5 値が KV table に分散 | 階層 JSON column 化を将来考慮 |
| transit_rides (new) | 設計健全 | gps_start_id / gps_end_id + station_id FK | OK |
| weather_daily (new) | 設計健全 | per-location per-day snapshot、lat/lon + date で UNIQUE index | OK |
| multi.servers (new) | 型不整合 | url: TEXT, jwt: TEXT | per-hub session state を explicit enum 化を推奨 |

**評価**: A

---

## 3. SRE観点のレビュー (SRE Review)

| 評価 | 観点 | 所見 |
|------|------|------|
| B | 可観測性 (Observability) | console.log で起動 log あり、structured logging なし |
| B | デプロイ安全性 | desktop app の bundler で server binary sync、Hub の blue-green deploy 戦略なし |
| B | スケーラビリティ | local: SQLite single-process for personal use、Hub: stateless で horizontal scale 可能 |
| B | 障害復旧 (Disaster Recovery) | local: SQLite backup は手動。Hub: Postgres backup strategy 不明記 |
| B | 依存関係管理 | npm package pinning by package-lock.json、npm audit 手動実行 |

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | コード品質 | B | 0 |
| 2 | データスキーマ | A | 0 |
| 3 | SRE | B | 1 |
