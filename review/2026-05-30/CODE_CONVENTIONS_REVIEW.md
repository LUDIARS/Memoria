# Memoria コード規約レビュー (2026-05-30)

規約: `AIFormat/RULE_CODE.md` (共通) + `Memoria/CLAUDE.md` 「コード規約 (Memoria 固有)」 — God Class 警戒 / 機能ごとのファイル分割 (`server/<domain>/`) / domain cross-import 禁止 / ナレッジ系切り出し前提 / レイヤ単方向 / 入力 UI `.foundation-form` / 個人データはローカル SQLite に閉じる。

## サマリ
- 違反件数: Critical 2 / High 4 / Medium 5 / Low 3
- 注目点: `server/db.ts` (5742 行 / 239 export) が全 domain の DB アクセスを 1 file に集約 → ナレッジ系切り出しの最大阻害要因。 routes 側は概ね domain 分割済だが note / packet-monitor に複合責務あり。

## God Class 一覧 (既存 / 新規追加禁止)

| ファイル | 主要責務 (推定) | 行数 | 推奨分割案 |
|---------|--------------|------|------------|
| `server/db.ts` | スキーマ + CRUD (bookmarks / notes / dig / diary / tasks / meals 全 domain) + migration + query helper | 5742 | `server/<domain>/db.ts` に分解 (= bookmarks/db.ts / notes/db.ts / dig/db.ts ...) + `server/shared/db-helpers.ts` |
| `server/routes/packet-monitor.ts` | TSV parse + DNS 逆引き + well-known service mapping + プロセス属性化 | 1026 | `routes/packet-monitor/analyzer.ts` + `lib/packet-analyzer.ts` + `lib/packet-process-attribution.ts` (既存) |
| `server/routes/note.ts` | Note CRUD + blocks + comment sets + extension rules (Chat / Shopping / Notion) + 外部 HTML parse | 870 | `routes/note/blocks.ts` + `routes/note/comments.ts` + `routes/note/extensions/*.ts` |

## Critical

- `server/db.ts:1267-5743` — God Class: 239 個の export function が単一 file に集約 (= 全 domain DB アクセスのハブ)
  - 違反: 共通 §1 (SRP) + §2 (ファイル分割) + Memoria 固有「God Class 新規禁止 + 機能ごと分割 + ナレッジ系切り出し前提」
  - 影響: bookmarks / notes / dig を独立サービス化しようとした瞬間に「db.ts を分けるところから」 になる。 切り出し前提を最も阻害している。
  - 修正提案: domain 単位で分割 → `server/bookmarks/db.ts` / `server/notes/db.ts` / `server/dig/db.ts` / `server/diary/db.ts` / `server/meals/db.ts` + 共通 helper (`safeParse` / `extractDomain` / 等) を `server/shared/db-helpers.ts` へ。 routes 側の import 1 行差し替えで段階移行可能。

- `server/llm.ts` (モデル定義) + `server/agent-dispatch.ts` (spawn 実装) — LLM dispatch が 2 file に責務 split (= 同種の関心が分散)
  - 違反: 共通 §1 (SRP の境界が曖昧) + §4 (命名: `LlmTaskName` vs `AgentKind` 混在)
  - 修正提案: `llm.ts` は「モデル構成 (provider / model id / params)」 のみに限定、 `agent-dispatch.ts` は「実行 (spawn / handle / log)」 のみに限定。 共通の型 (TaskName 等) は `server/shared/llm-config.ts` に集約。

## High

- `server/routes/packet-monitor.ts:1-1026` — TSV parse + DNS lookup + well-known service classify + process attribution が同居
  - 違反: 共通 §1 (責務過多)
  - 修正提案: `routes/packet-monitor/analyzer.ts` (flow grouping のみ) + `lib/packet-analyzer.ts` (well-known service 判定) + `lib/packet-process-attribution.ts` (既存。 責務境界を明示)。

- `server/routes/note.ts:1-870` — Note CRUD + Block 管理 + CommentSet + Extension (Chat / Shopping / Notion) が混在
  - 違反: 共通 §1 (複数責務) + §2 (extension ごとに分割可能)
  - 修正提案: `routes/note/blocks.ts` / `routes/note/comments.ts` / `routes/note/extensions/{chat,shopping,notion}.ts`。 extension は `server/shared/extension-*.ts` 候補。

- `server/db.ts:35-50` — helper (`safeParse` / `extractDomain` / `firstPathSegment`) が db.ts 内に同居 + 他 file でも重複実装
  - 違反: 共通 §2 (DRY / 配置先誤り)
  - 修正提案: `server/shared/url-helpers.ts` に集約、 db.ts / diary.ts / dig.ts から import。

- `server/agent-dispatch.ts:179, 357, 393` — `catch (e)` で型注釈 / message log なし (= silent failure 化リスク)
  - 違反: 共通 §「例外の空 catch 禁止 (理由コメント必須)」 + §「TS strict / any 濫用しない」
  - 修正提案: `catch (e: unknown) { console.error('agent spawn failed:', e); ... }` に統一。 swallow する場合は best-effort 理由を 1 行コメント。

## Medium

- `server/concordia-spawn-client.ts:110, 248` — `catch (e)` で console log なし、 throw のみ (= 上流で握りつぶされた場合に痕跡が残らない)
  - 修正提案: `} catch (e) { console.error('spawn client error:', e); throw ...; }` を default に。

- `server/lib/activity-sampler.ts:87, 138, 196` / `server/lib/app-activity-sampler.ts:34` — `catch (e)` で型注釈なし + 理由コメントなし
  - 修正提案: `catch (e: unknown)` 統一、 debug log 追加。

- `server/routes/bookmark.ts:40-50` — 型キャスト (`as | null`) の連鎖でリクエスト body を扱う
  - 違反: 共通 §5 (型安全性 / any 濫用)
  - 修正提案: zod / valibot で body 検証、 `routes/types/bookmark-request.ts` に schema 集約。

- `server/db.ts:1485, 1493` — `setDigPreview` / `setDigRawResults` の引数が `unknown` (= JSON stringify で処理)
  - 違反: 共通 §5 (公開境界での型省略)
  - 修正提案: `DigestPreview` / `DigestRawResults` 型を定義 + 渡し側で型固定。

- `server/routes/dig.ts:29-32` — request body キャストが雑 (`as | null`)
  - 修正提案: `routes/types/dig-request.ts` で `DigCreateRequest` を定義、 zod で validate。

## Low

- `server/url-preview.ts:89` — `reader.cancel().catch(() => {})` の意図が不明
  - 修正提案: `.catch(() => { /* stream cleanup; ignore errors */ })` でコメント付与。

- `server/concordia-spawn-client.ts:223` — `json.catch(() => ({}))` で空 object を返す (= parse 失敗を黙殺)
  - 修正提案: `catch (e) { console.error(...); throw new Error('spawn-client parse failed'); }` に。

- `server/app-catalog.ts:72-73` — JSON parse 失敗時に raw 全文を log 出力
  - 違反: Memoria 固有「個人データ」 (= 外部 API response がアカウント情報を含む可能性)
  - 修正提案: 先頭 100 char のみ log、 詳細は `NODE_ENV !== 'production'` 時のみ。

## ナレッジ系切り出し可否 (Memoria 固有の最重要観点)

| domain | 切り出し可否 | 阻害要因 / 対処 |
|--------|--------------|----------------|
| **bookmarks** | ◯ ほぼ可 | `server/db.ts` 内の bookmark 関数群が独立。 db.ts 分割が前提条件、 完了すれば `server/bookmarks/{db,routes}.ts` だけで切り出せる |
| **notes** | △ 軽微な阻害 | block + comment は内部完結。 extension (Chat / Shopping / Notion) を `server/shared/extension-*.ts` 経由化で独立性向上。 `getBookmark(db, ...)` 直接呼び出しは interface で隔離する |
| **dig** | △ 要 refactor | `db/types/dig.ts` は独立。 `routes/dig.ts` で `bulkSaveDeps` (= bookmarks integration) を呼ぶため、 DI で明示化 → bookmarks service への HTTP 呼び出しに差し替え可能にする |
| diary / meals | △ 影響小 | db.ts 分割と同じスコープで一緒に切れる |

## 全体評価

- **routes/ 分割**: 概ね domain 単位で分かれており健全 (= packet-monitor / note を除く)。
- **筆頭リスク**: `server/db.ts` の God Class 化。 ここを domain 別に割れば「ナレッジ系切り出し前提」 規約が一気に守られる。
- **次点**: error handling の型注釈 / log 出力の不統一。 「サイレント失敗」 が混じる risk を消す。

## 推奨優先度

1. **Critical**: `server/db.ts` を domain 別に分割 (= 単独で大きい PR、 機能変更は伴わない pure refactor)
2. **High**: 大型 routes (note / packet-monitor) の責務分割 + LLM dispatch の境界整理
3. **Medium**: error handling 統一 (`catch (e: unknown)` + console.error + 理由コメント)
4. **Low**: 型強化 (zod / valibot) + 個人データ log の絞り込み
