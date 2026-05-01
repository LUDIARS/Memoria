# Memoria Server AIFormat レビュー (2026-05-01)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Memoria |
| 対象ブランチ | main |
| レビュー実施日 | 2026-05-01 |
| 対象コミット範囲 | 〜 `77d3a1b` (PR #90 merged) |
| 評価対象 | `server/` (≒ 9135 行) |

## 前提

Memoria の **ローカルモード** は個人 PC 内部 で動作し、外部からデータを受け取らず、外部へも (ユーザー操作なしには) 送信しない。`Multi Hub` モードは Cernere SSO + 公開コンテンツ (辞書 / Dig / ブックマーク) のみを扱う設計。

このため AIFormat の脆弱性 / ゼロトラスト軸はローカル前提で評価を緩和し、**設計強度 / モジュール分割度 / 実装品質 / テスト** を主軸にレビューする。

## 総合評価

| # | 観点 | 評価 | 重大指摘数 | 備考 |
|---|------|------|-----------|------|
| 1 | 設計強度 | **B** | 0 | 機能は動く。 fail-safe / retry はキュー層に集約済 |
| 2 | 設計思想の一貫性 | **C** | 2 | LUDIARS 標準 (Drizzle / Zod / TS) から逸脱 |
| 3 | モジュール分割度 | **D** | 3 | `index.js`/`db.js`/`diary.js` が God Object |
| 4 | コード品質 | **C** | 2 | 重複定義、長関数、層越境 |
| 5 | データスキーマ | **B** | 0 | SQLite 構造は妥当、 nutrients / additions の JSON シリアライズは局所最適 |
| 6 | SRE | **C** | 1 | ログ非構造化、 health check 不在 |
| 7 | テスト戦略 | **D** | 1 | テスト 0 件 |
| 12 | パフォーマンス | **B** | 0 | bookmarks ページング済 (#89)、 diary 集計はインデックスあり |
| 14 | ライセンス | **A** | 0 | MIT、 deps は OSS |
| 15 | クロスプラットフォーム | **A** | 0 | Win/macOS/Linux で Electron 動作確認済 |
| 16 | ドキュメント | **B** | 0 | README + multi-server-architecture.md あり、 機能仕様は無し |

## 1. 設計レビュー

### 1.1 設計強度 (B)

- ✅ 入力バリデーション — `c.req.json()` 後に手書きで type check + clamp。 漏れなし
- ✅ エラーハンドリング — try/catch + queue ベースで failure isolation。 ai_status='error' で UI に伝播
- ✅ 競合状態 — better-sqlite3 は同期 API、 単一プロセスの SQLite で race なし
- ⚠ **タイムアウト** — LLM 呼び出しは `timeoutMs` 受けるが、 HTTP 受信側の req timeout 未設定 (Hono 既定)
- ⚠ **冪等性** — `/api/meals/:id/reanalyze` などは idempotent だが、 `/api/dig` は同 query を 2 回 POST すると別 session が作られる (意図的か?)

### 1.2 設計思想の一貫性 (C — 重大 2)

| 該当箇所 | 逸脱 | LUDIARS 標準 | 推奨 |
|---|---|---|---|
| 全体 | 言語が JavaScript | TypeScript | **C: 段階移行 (このレビュー後の Step 2-5 完了を先行)** |
| `db.js` 全体 | 直接 SQL + better-sqlite3 | Drizzle ORM | C: ローカル SQLite のままなら drizzle-orm の sqlite ドライバへ |
| バリデーション無し | 手書き type check | Zod | B: API 入出力に Zod 導入 |
| `public/app.js` | 単一 6000+ 行 vanilla JS | React + Vite + TS | C: 別 PR で SPA 化 (Foundation UI に揃える) |

注: Memoria は SQLite + 単独プロセスという特殊性により、 PostgreSQL + Redis + Drizzle スタックには直接ハマらない。 Drizzle は SQLite ドライバが用意されているので、 SQL 互換性は維持できる。

### 1.3 モジュール分割度 (D — 重大 3)

#### 重大 #1: `server/index.js` (3288 行 / 121 endpoints / 28 API groups)

ルーター + サービス層 + バックグラウンドキュー + WebSocket + push 通知 が 1 ファイルに同居。 God Object 化している。

機能群別 endpoint 数 (主なもの):

| API グループ | endpoint 数 | ファイル割当 |
|---|---|---|
| `/api/bookmarks` | 7 | `routes/bookmarks.ts` |
| `/api/meals` | 11 | `routes/meals.ts` |
| `/api/dig` | 7 | `routes/dig.ts` |
| `/api/wordcloud` | 7 | `routes/wordcloud.ts` |
| `/api/dictionary` | 8 | `routes/dictionary.ts` |
| `/api/diary` | 9+ | `routes/diary.ts` |
| `/api/trends` | 8 | `routes/trends.ts` |
| `/api/locations` (GPS) | 4+ | `routes/locations.ts` |
| `/api/push` | 5 | `routes/push.ts` |
| `/api/recommendations` | 2 | `routes/recommendations.ts` |
| `/api/queue` `/api/visits` `/api/categories` ほか | 〜 | `routes/admin.ts` |
| `/api/multi/*` | 多数 | `multi/routes/*.ts` (既存 multi/ に寄せる) |

推奨: `server/routes/<group>.ts` に分割し、 `server/index.ts` は app 構築 + middleware + ルート mount のみにする (50〜100 行目安)。

#### 重大 #2: `server/db.js` (2022 行 / 112 export functions)

リポジトリ層が単一ファイル化。 11 ドメインのアクセサが混在。

推奨分割:

```
server/db/
├── index.ts          (openDb + 共通 migration runner)
├── schema.ts         (Drizzle schema、 移行後)
├── bookmarks.ts      (listBookmarks / countBookmarks / getBookmark / insertBookmark / setSummary 等)
├── visits.ts         (upsertVisit / listUnsavedVisits / deleteVisit / listSuggestedVisits)
├── dig.ts            (insertDigSession / setDigResult / setDigPreview / setDigRawResults / digThemeContext / digSessionsForDate)
├── wordcloud.ts      (insertWordCloud / setWordCloudResult / getWordCloud / listWordClouds / getBookmarkWordCloud)
├── dictionary.ts     (listDictionaryEntries / get / find / insert / update / delete / addLink / removeLink)
├── page-metadata.ts  (getPageMetadata / getPageMetadataMap / insertPending / setPageMetadata / deletePageMetadata)
├── domain-catalog.ts (getDomainCatalog / listDomainCatalog)
├── diary.ts          (diary_entries / weekly_reports / diary_settings)
├── meals.ts          (meal_records CRUD + additions JSON helper)
├── push.ts           (push_subscriptions CRUD)
├── gps.ts            (gps_locations 関連)
├── multi/            (owner / shared フィールド管理は多分 multi 専用)
└── settings.ts       (app_settings / stopwords)
```

#### 重大 #3: `server/diary.js` (1212 行 / 関心混在)

diary.js は **DB 集計 / GPS 計算 / 栄養素 / GitHub API / LLM プロンプト組み立て / LLM 呼び出し / 日付ユーティリティ** が 1 ファイル。

推奨分割:

```
server/diary/
├── aggregate.ts   (aggregateDay 主体: DB → metrics)
├── gps.ts         (summarizeGpsForDate / haversineMeters / parseSqliteUtc)
├── nutrition.ts   (loadUserProfile / computeBmrMifflin / computeCaloricBalance)
├── github.ts      (fetchGithubActivity / pingGithub / fetchGithubRange / summarizeGithubByRepo)
├── prompt.ts      (formatGpsBlock / formatMealsBlock / formatCaloricBalanceBlock / buildUrlList)
├── generate.ts    (generateWorkContent / generateHighlights / generateDiary / generateWeekly)
└── date.ts        (formatLocalDate / yesterdayLocal / weekRangeFor / weekOfMonth)
```

`date.ts` は他モジュール (`meals` の `formatLocalMealDateTime`, `index.js` の `parseSqliteUtc` 重複) と統合可能。

## 2. 実装評価

### 2.1 コード品質 (C — 重大 2)

| 該当箇所 | 問題分類 | 説明 | 推奨 |
|---|---|---|---|
| `server/index.js:695` & `server/diary.js:257` & `server/public/app.js:5227` | DRY 違反 | `parseMealAdditions` / `parseMealAdditionsJson` / `parseAdditions` が 3 重定義 | 共通 `lib/meal-additions.ts` に集約 |
| `server/diary.js:29` & 他 | DRY 違反 | `parseSqliteUtc` を複数箇所で実装 | `lib/date.ts` に集約 |
| `server/index.js:1010-1100` | 長関数 | meals additions 3 endpoint 内に similar logic | service 層に抽出 |
| `server/index.js:710-810` | ネスト深い | meal POST が EXIF/GPS/Vision/manual を 1 関数で処理 | 段階別に関数化済の部分は良い |
| `server/diary.js:483-628` | 不透明 | `formatCommit` `summarizeGithubByRepo` が密結合 | github.ts に分離する際に整理 |
| 全ファイル | console.log / err.message 直書き | 構造化ログ無し | pino / winston 導入 |
| `multi/auth.js` | マジック値 | JWT TTL / cookie name 等が散在 | `multi/config.ts` に集約 |

### 2.2 データスキーマ (B)

| テーブル | 評価 | 備考 |
|---|---|---|
| `bookmarks` / `bookmark_categories` / `accesses` | B | 正規化済、 owner_user_id NULL = 自分 |
| `page_visits` + `visit_events` | B | 集計 vs イベントを分離、 適切 |
| `dig_sessions` | B | preview/result/raw を別 column。 JSON のままで OK |
| `dictionary_entries` + `dictionary_links` | B | source_kind enum はスキーマ外。 lib に定数化推奨 |
| `word_clouds` | B | parent_cloud_id でチェーン構造。 origin enum は同様 |
| `meal_records` | C | `additions_json` `nutrients_json` `items_json` を JSON 文字列で保存 → SQLite なら問題ないが、 Drizzle 移行時に `.json()` カラム型へ |
| `domain_catalog` `page_metadata` | A | URL/domain 単位で適切にユニーク |
| `diary_entries` | B | metrics_json / github_commits_json は JSON 文字列。 同上 |
| `gps_locations` | B | 軌跡用に時刻 index あり |
| `push_subscriptions` | B | revoked_at で論理削除、 endpoint UNIQUE |

スキーマ自体は健全。 「正規化不足」 は無く、 JSON カラムも SQLite + 単独プロセスでは妥当。 Drizzle 化の時に `text({ mode: 'json' })` で型付け可能。

### 2.3 SRE (C — 重大 1)

| 観点 | 評価 | 備考 |
|---|---|---|
| 可観測性 | C | console.log のみ。 trace / req id 無し |
| デプロイ安全性 | B | desktop は electron-builder で artifact 管理。 server 単体は手動 |
| **障害復旧** | **C (重大)** | DB の auto-backup 無し。 個人 PC 故障時の救済策無し |
| 依存関係管理 | B | npm + lockfile。 better-sqlite3 native はリリースビルド時にチェック必要 |
| ヘルスチェック | C | `/api/uptime` は server_events 用、 純粋な health endpoint 無し |

推奨: SQLite を `data/memoria.db.bak-yyyymmdd` に日次 rotate。 desktop 起動時に自動。

## 3. 不足機能

| 種別 | 提案 | 優先度 |
|---|---|---|
| バックアップ | SQLite 日次バックアップ + 7 日保持 | 中 |
| Health endpoint | `GET /healthz` (db ping + queue depth) | 低 |
| 構造化ログ | pino + ログレベル env 制御 | 中 |
| フロントエンド SPA 化 | React + Vite + TS で `public/app.js` 6000 行を分割 | 中〜大 (別 PR) |
| Type 化 | サーバを TS、 Drizzle ORM 化 | 大 (この計画の最後) |
| Multi の OpenAPI | `/api/multi/*` のスキーマ公開 | 低 |

## 4. 品質保証 (テスト戦略 D — 重大)

| 観点 | 評価 | 備考 |
|---|---|---|
| **テストカバレッジ** | **D (重大)** | テスト 0 件。 統合 / ユニットいずれも無し |
| 性能ベンチ | C | bookmarks 50 件ページングは手動確認。 数値不明 |
| ライセンス | A | MIT。 dep の license は npx license-checker で要確認 |
| クロスプラットフォーム | A | Electron で 3 OS 動作実績あり |
| ドキュメント | B | README + 多サーバ設計書はある。 API spec / 機能仕様無し |

テスト導入順位 (Step 3 で着手):

1. **db レイヤー** — メモリ SQLite + 各 repository 関数 (`listBookmarks` `getDigSession` 等の境界値)
2. **diary 計算系** — `summarizeGpsForDate` `computeBmrMifflin` `computeCaloricBalance` (純関数、 テスト容易)
3. **routes 層** — supertest 風に Hono の `app.fetch` を直叩き、 fixture DB
4. **LLM 呼出は mock 化** — `runLlm` を vi.fn 等で差し替え

ランナーは **Vitest** を推奨 (LUDIARS 他サービスと揃え、 Vite との親和性も高い)。

## 5. ゼロトラスト / 脆弱性 (緩和評価)

ローカルモード前提で **B** とする (絶対値では C 相当)。

| 項目 | 状態 | 緩和理由 |
|---|---|---|
| CORS `*` | 有 | localhost only 想定なので OK。 ただし Multi Hub では origin allowlist に変更要 |
| 認証無し routes (`/api/*`) | 有 | 同上。 Hub は `authedUser()` で Bearer 検証済 |
| SQL injection | 無 | better-sqlite3 prepared statements |
| Path traversal | リスク低 | `meals/:id/photo` で `id` を `Number()` cast 済 |
| LLM prompt injection | 残存 | bookmark 要約 / dig などで攻撃者 URL の文字列が prompt に流入。 個人 PC 内なので影響範囲は本人のみ |
| WebPush 鍵保管 | OK | VAPID 鍵は data/ に永続化、 gitignore |

Multi Hub に切り出すコンポーネント (multi/auth.js + Cernere SSO) はこの評価から外し、 Cernere 側で別途レビューする方針が筋。

## 6. アクションリスト (Step 2 以降に持ち越し)

優先順 (高 → 低):

1. **(D)** `server/index.js` を `routes/<group>.ts` に分割、 `server/index.ts` を 100 行以下に
2. **(D)** `server/db.js` を `db/<domain>.ts` 13 ファイルに分割
3. **(D)** `server/diary.js` を `diary/<aspect>.ts` 7 ファイルに分割
4. **(D)** Vitest 導入 + 既存純関数 (gps / nutrition / date) のユニットテスト
5. **(C)** `parseMealAdditions` 3 重定義を `lib/meal-additions.ts` に集約
6. **(C)** `parseSqliteUtc` 重複を `lib/date.ts` に集約
7. **(C)** API I/O に Zod スキーマ導入
8. **(C)** SQLite 日次バックアップ
9. **(B)** 構造化ログ (pino)
10. **(B)** Drizzle ORM 化 (sqlite ドライバ)
11. **(B)** TS 化 (上記がすべて整ってから tsx 化が現実的)

## 7. 結論

- 機能としては成熟しており、 PR #90 まで多くの機能を統合してきた
- **God Object 3 つ** (`index.js`, `db.js`, `diary.js`) が refactor の最大ボトルネック
- テスト 0 件は次の TS 化 / Drizzle 化のリスク要因 — まず現状の挙動を pin するテストを書く
- TS 化 / Drizzle 化 / SPA 化 は 1 PR では不可能。 順序立てた計画で別 PR 群に分ける
- セキュリティはローカルモード前提で問題なし。 Multi Hub 公開時は別レビュー
