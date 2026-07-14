# 不足機能評価 (Missing Feature Evaluation)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Memoria |
| 対象ブランチ / PR | main (Phase 6 multi-hub) |
| レビュー実施日 | 2026-05-15 |
| 対象コミット範囲 | 678bbb1..HEAD |

---

## 1. 機能の改善提案 (Feature Improvement)

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
|---------|---------|---------|--------|
| Multi proxy path matching | regex hardcode を configurable mapping table に変更 | maintainability 向上 | Medium |
| Weather API error handling | Open-Meteo timeout / 503 時の fallback (cached forecast) | UX 改善 | Medium |
| Timezone handling | TZ edge case (iOS GMT fallback, DST transition) のテスト化 | 国際利用時の correctness | Low |
| Infisical secret refresh | hot reload (restart 不要な secret sync) | 運用負荷軽減 | Low |
| Activity/Games logging | Steam appid → name resolution の並列化 | 起動遅延削減 | Low |

---

## 2. 不足機能の提案 (Missing Feature Proposal)

| 提案機能 | 必要性の根拠 | 実装優先度 | 想定影響範囲 |
|---------|------------|-----------|------------|
| Unit / Integration test suite | 150+ TS files、新実装 (weather/transit/multi-proxy) で smoke test 最低限必須 | **High** | server/ 全体、CI pipeline |
| Health check endpoint (`GET /health`, `GET /ready`) | docker-compose / k8s deployment の liveness/readiness probe | **High** | server/index.ts |
| API key leak detection | Infisical secret / error message に sensitive value | **High** | CI (npm audit + custom SAST) |
| Structured logging (JSON format) | console.log → Winston/Pino migration | **Medium** | server/lib/logger.ts (new) |
| Rate limiting (login / API endpoints) | Hub login brute-force attack 対策 | **Medium** | server/multi/ |
| Audit log for Hub CRUD | admin/moderator が data delete した記録 | **Medium** | server/multi/audit-log.ts |
| E2E test for Multi mode | local ↔ Hub proxy 統合テスト | **Medium** | e2e/ directory (new) |
| Database migration rollback procedure | schema downgrade のランブック | **Low** | docs/runbooks/ |

---

## 総合評価

| # | レビュー観点 | 指摘数 | 優先度別内訳 |
|---|------------|--------|------------|
| 1 | 機能改善 | 5 | High: 0 / Medium: 3 / Low: 2 |
| 2 | 不足機能 | 8 | High: 3 / Medium: 3 / Low: 2 |
