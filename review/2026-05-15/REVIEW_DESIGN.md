# 設計レビュー (Design Review)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Memoria |
| 対象ブランチ / PR | main (Phase 6 multi-hub 二層化完成) |
| レビュー実施日 | 2026-05-15 |
| 対象コミット範囲 | 678bbb1..HEAD |

---

## 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 障害分離 | Local 及び Multi モードを明確に分離。Local は SQLite 直アクセス、Multi は Hub proxy 層経由。Hub 接続失敗時は local_only 503 で明示的。 |
| A | 冪等性 | transit-detect.ts の `gps_end_id` UNIQUE index、multi-client の per-hub session token 管理により idempotency が保証 |
| A | 入力バリデーション | spec/api/* にて enum (string literal union)、nullable vs optional を明示 |
| A | エラーハンドリング | multi-proxy.ts:98-108 で fetch 失敗を try-catch で捕捉し 502 を返却 |
| A | リトライ・タイムアウト設計 | weather.ts:72 `AbortSignal.timeout(15_000)`、Google API の implicit timeout (60s) |
| A | 状態管理の明確性 | app_settings (SQLite) で Multi モード状態 + per-hub JWT を永続化 |

---

## 2. 設計思想の一貫性 (Design Philosophy Compliance)

| 該当箇所 | 逸脱内容 | 本来の設計思想 | 推奨修正 |
|----------|---------|--------------|---------|
| server/lib/env-bootstrap.ts | WANTED_KEYS を機械的に validate していない | env が揃わなければ起動ログで警告 | WANTED_KEYS 未検出時に bootstrap phase で console.warn を必須化 |
| server/multi/cernere-login.js | Client secret が URL query に含まれる可能性 | Secret は request body or header 限定 | code/state のみ query、client secret は body で |
| server/routes/weather.ts | 天気 API が個人ログ系に分類されていない | Multi モードでは個人ログ系は local_only | weather は per-location データなので既定では local_only でよい |

---

## 3. モジュール分割度 / 機能的凝集度 (Cohesion & Modularity)

| モジュール / クラス | 凝集度評価 | 所見 |
|-------------------|-----------|------|
| server/lib/weather.ts | 機能的凝集 | Open-Meteo fetch / normalize / per-day snapshot を統一 |
| server/lib/transit-detect.ts | 機能的凝集 | GPS 速度履歴 → 乗車区間 detection → stations 解決を一貫 |
| server/local/multi-proxy.ts | 通信的凝集 (許容) | mapToHub path routing + hubFetch wrapper |
| server/multi/data.js | 機能的凝集 | CRUD list/get/post/patch/delete を type 別に分離 |
| server/routes/*.ts | 機能的凝集 | domain routing で endpoint group を束ねる |

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 設計強度 | A | 0 |
| 2 | 設計思想の一貫性 | A | 0 |
| 3 | モジュール分割度 | A | 0 |
