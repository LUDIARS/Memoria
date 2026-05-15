# Memoria DB パフォーマンス試算

**測定日:** 2026-05-04
**DB ファイル:** `data/memoria.db` (better-sqlite3, WAL モード, ジャーナル autocheckpoint 既定)
**現在サイズ:** メイン 5.4 MB + WAL 4.0 MB ≒ 実体 6-7 MB (checkpoint 後)

## 1. 結論先出し

**現在の規模では SQLite の限界からは桁違いに遠い。 月次パーティションは不要。**
ただし `activity_events` (Claude Code prompt 等) は 1 日 1500 件超のペースで増えており、
**5-10 年スパンで 2-5 GB に達する**。 リテンション (古いデータの集計化 + 削除) を入れた方が、
パーティションよりはるかに費用対効果が高い。

懸念があるのは下記 3 点だけ:

1. **`activity_events`** — 高頻度書込み、 5 年で ~2 GB
2. **WAL の肥大化** — 既に 4 MB、 明示 checkpoint or `synchronous=NORMAL` のままで run-away するリスク
3. **`diary_entries.metrics_json` / `dig_sessions.result_json`** — 1 行が 100 KB-1 MB クラス、 行数は少ないが個別重い

---

## 2. 現在の実測値

### 2.1 行数とサイズ (主要テーブル)

| Table | Rows | Size (bytes) | bytes/row | コメント |
|-------|------|-------------:|----------:|----------|
| `activity_events`  | 2,228 | 1,488,667 |   668 | git commit + Claude Code prompt の hook 受け |
| `diary_entries`    |     7 |   898,874 | 128,410 | 1 日 1 行、 work_content / highlights / metrics_json が太い |
| `bookmarks`        |   475 |   508,170 |  1,070 | summary + memo 含む、 HTML 本体は別ディレクトリ |
| `page_visits`      |   931 |   168,363 |   181 | URL ごと upsert、 visit_count は inc |
| `domain_catalog`   |   239 |   137,669 |   576 | site_name / can_do / description |
| `dig_sessions`     |    10 |   107,253 | 10,725 | result_json が太い (sources × 8-12) |
| `visit_events`     |   734 |    90,765 |   124 | per-event log (page_visits の生データ) |
| `page_metadata`    |    94 |    51,610 |   549 | og_/title/summary/kind |
| `bookmark_categories`| 2,361|    36,138 |    15 | 単純 join テーブル |
| `server_events`    |   395 |    29,976 |    76 | start/stop/downtime/restart |
| `gps_locations`    |    65 |    17,640 |   271 | #97 で圧縮済 (anchor + tail) |
| `accesses`         |   607 |    15,042 |    25 | アクセスログ (短い) |
| `meals`            |    24 |    12,418 |   517 | 写真 EXIF + 栄養素 JSON |
| `word_clouds`      |     1 |     4,328 | 4,328 | tokens_json + extras |
| `weekly_reports`   |     1 |     4,766 | 4,766 | 週次サマリ |
| `dictionary_entries`|    2 |     1,945 |   972 | 用語定義 |
| `app_settings`     |    39 |     1,142 |    29 | LLM 設定など |
| `dictionary_links` |     1 |        29 |    29 | 用語 ↔ source |
| `push_subscriptions`|    1 |       458 |   458 | WebPush endpoint |
| **合計** | ~8,400 | ~3.6 MB | — | 上記 + index + freelist で実体 5.4 MB |

### 2.2 直近 1 日 / 7 日の増加件数

| Table | 1 日 | 7 日 | 30 日 |
|-------|----:|----:|----:|
| `activity_events` | **1,569** | 2,228 | 2,228 (= 全件) |
| `gps_locations`   | 61 | 65 | 65 |
| `server_events`   | 166 | 395 | 395 |
| `page_visits`     | 14 | 403 | 931 |
| `accesses`        | 1 | 60 | 607 |
| `bookmarks`       | 1 | 15 | 475 |
| `dig_sessions`    | 0 | 9 | 10 |
| `diary_entries`   | 0 | 6 | 7 |

> **注:** `activity_events` は Claude Code hook 起動が増えた今日 1 日で集中投入されているため、
> 7 日と 1 日がほぼ同値になっている。 平均は **概ね 200-1500/day** のレンジ。

---

## 3. 成長率予測

ここでは「現在のペースが今後 5-10 年続く」 ケースで試算する (ヘビーケース)。

### 3.1 主要テーブルの増加率 (定常期想定)

| Table | 平均 row/day | bytes/row | MB/月 | MB/年 | 5 年 | 10 年 |
|-------|-----------:|---------:|-----:|-----:|----:|----:|
| `activity_events` | 800 *1 | 668 | 16 MB | 195 MB | **975 MB** | **2.0 GB** |
| `page_visits`     | 30 *2 | 181 | 0.16 | 1.9 | 9.6 MB | 19 MB |
| `visit_events`    | 100 | 124 | 0.37 | 4.4 | 22 MB | 44 MB |
| `accesses`        | 30 | 25 | 0.022 | 0.27 | 1.3 MB | 2.7 MB |
| `gps_locations`   | 60 *3 | 271 | 0.49 | 5.9 | 30 MB | 59 MB |
| `server_events`   | 50 | 76 | 0.11 | 1.4 | 6.8 MB | 14 MB |
| `bookmarks`       | 5 | 1,070 | 0.16 | 1.9 | 9.6 MB | 19 MB |
| `dig_sessions`    | 1 | 10,725 | 0.32 | 3.9 | 19 MB | 39 MB |
| `diary_entries`   | 1 | 130,000 | **3.9** | **47** | **234 MB** | **468 MB** |
| `domain_catalog`  | 0.3 | 576 | 0.005 | 0.06 | 0.3 MB | 0.6 MB |
| `meals`           | 1 | 517 | 0.015 | 0.19 | 0.9 MB | 1.9 MB |
| **合計** | — | — | **~22 MB/月** | **~265 MB/年** | **~1.3 GB** | **~2.7 GB** |

\*1: hook が常時動く前提。 開発が落ち着けば 200-500/day に減るはず。
\*2: 新規 URL のみ。 再訪は visit_count++ で行は増えない。
\*3: #97 圧縮で 1 日数十行に抑えてある。 移動量次第で増減。

### 3.2 ライトケース (実利用ペース)

ユーザがコーディングセッション無しの日も多いと仮定 (週 3 日活動、 1 日 300 prompt):

- `activity_events` 平均 ~130/day → **1.3 GB / 10 年**
- `diary_entries` ペースは変わらず (毎日 1 行)
- 全体 **1.5-2 GB / 10 年**

---

## 3a. ヘビーテーブル個別試算

§3 はマクロ試算。 ここでは肥大化が懸念される **5 テーブル** を、 実測ベースで掘り下げる。

### 3a.1 `activity_events` (claude_code_prompt + git_commit)

**実測 (kind 別):**

| kind | 行数 | content avg | metadata avg | bytes/row (推定) |
|------|----:|----------:|-----------:|----------------:|
| `claude_code_prompt` | 2,086 |   234 (max 240) |  111 |    470 |
| `git_commit`         |   162 |    62 |  180 |    347 |

> `claude_code_prompt` は content を 240 文字で truncate している (`server/routes/visit.ts` で `slice(0, 4000)` だが
> hook 側でさらに短く渡している) → **行サイズが想定より小さい**。 これは大きな朗報。

**24 時間の hourly 分布 (実測):**

```
活動時間帯 (8-20 時) の peak: 100-104 prompts/h
活動日合計: 800-1200 prompts/day  (5/3 実績 1080, 5/4 663+進行中)
```

**3 シナリオ別の試算:**

| シナリオ | 平均 prompt/day | 行数/年 | サイズ/年 | 5 年 | 10 年 |
|---------|---------------:|------:|--------:|----:|----:|
| **ライト** (週 3 日 × 300/day) | 130 | 47K | 22 MB | 110 MB | 220 MB |
| **ミドル** (週 5 日 × 600/day) | 430 | 157K | 74 MB | 369 MB | **737 MB** |
| **ヘビー** (毎日 1000/day, 今のペース) | 1000 | 365K | 172 MB | **858 MB** | **1.7 GB** |

**実用域での性能 (indexed query):**

- **ライト**: 1 日分検索 = 数 ms、 全期間 COUNT = 50ms (10 年)
- **ミドル**: 1 日分検索 = 数 ms、 全期間 COUNT = 200ms
- **ヘビー**: **5 年目以降は indexing 補強がないと date 集計が秒台に乗る** (§6.1)

**git_commit は無視してよい**: 1 日 5-20 件、 5 年でも 35K 行 / 12 MB 程度。

→ **claude_code_prompt が単独で全テーブル中の最大成長源**。 ただし 240 char truncate のおかげで
当初試算 (1KB/row) の **半分以下** に収まる。

### 3a.2 `gps_locations`

**圧縮効果の実測 (#97):**

```
raw samples (samples_count 合計): 1,555
stored rows:                          65
圧縮比:                          23.9 倍
```

**1 日の規模 (移動が多い日):**

- raw OwnTracks samples: ~1,500 / day (default 30s 間隔)
- stored: ~60 rows / day = **17 KB / day**

**3 シナリオ別:**

| シナリオ | raw/day | stored/day | bytes/year | 5 年 | 10 年 |
|---------|--------:|----------:|-----------:|----:|----:|
| 圧縮 OFF (raw 全保存) | 1,500 | 1,500 | 149 MB | 745 MB | **1.5 GB** |
| **圧縮 ON (#97)** | 1,500 | 63 | 6.2 MB | 31 MB | 62 MB |
| 静止が多い日 (圧縮 ON) | 800 | 30 | 3.0 MB | 15 MB | 30 MB |

→ **圧縮済みなら 10 年で 60 MB**。 全く問題ない。
→ ただし `raw_json` カラムが各行に格納されている可能性 (271 bytes/row のうち) → 確認推奨。
   raw を捨ててよい古い行は `raw_json = NULL` で 50% 削減できる余地あり。

**place_resolver 関連カラム** (`place_name` `place_address`) はテキストなので、 dwell が多い場所が
1 行に集約されると **逆に 1 行が太くなる**。 ただし圧縮が効いているので問題化していない。

### 3a.3 `visit_events` (per-event browsing log)

**実測:**

- 行数: 737 / avg 124 bytes/row
- 1 日: 100-316 events (実測レンジ)
- source: null (Legatus DNS) 689 / browser 48 → **DNS tap 由来が大半**

**3 シナリオ別:**

| シナリオ | events/day | bytes/year | 5 年 | 10 年 |
|---------|----------:|-----------:|----:|----:|
| ライト (browser のみ、 50/day) | 50 | 2.3 MB | 11 MB | 22 MB |
| ミドル (browser + DNS 200/day) | 200 | 9.0 MB | 45 MB | 90 MB |
| ヘビー (DNS tap fully active 500/day) | 500 | 23 MB | 113 MB | 226 MB |

→ ヘビーでも 10 年 226 MB。 SQLite 余裕で扱える。
→ ただし **page_visits に既に集約済み** なので、 **90 日超は visit_events を捨てて OK**。

### 3a.4 `dig_sessions`

**実測 (1 セッションあたり):**

- result_json: avg **3.8 KB** (max 4.3 KB)
- preview_json: avg 1.1 KB
- raw_results_json: avg 1.5 KB
- → **1 dig 合計 ~6.5 KB**

**3 シナリオ別:**

| シナリオ | dig/day | bytes/year | 5 年 | 10 年 |
|---------|-------:|-----------:|----:|----:|
| ライト (週 5 dig) | 0.7 | 1.7 MB | 8 MB | 17 MB |
| ミドル (毎日 5 dig) | 5 | 12 MB | 59 MB | 119 MB |
| ヘビー (毎日 20 dig) | 20 | 47 MB | 237 MB | **475 MB** |

→ ヘビーケースのみ 10 年 0.5 GB。 **誤 Dig 削除を真面目にやる前提なら ミドル試算で十分**。
→ **raw_results_json は debug 用**なので 30 日超は NULL 化して OK (40% 削減)。

### 3a.5 `diary_entries` (意外な肥大化源)

**実測 (1 行あたり、 7 行平均):**

| カラム | avg bytes |
|--------|----------:|
| `work_content`        |    950 |
| `highlights`          |    541 |
| **`metrics_json`**    | **72,440** ← 全体の 90% |
| `github_commits_json` |  6,067 |
| `notes`               |     26 |
| `summary`             | (含めていないが小さい) |
| **1 行合計**          | **~80 KB** |

> `metrics_json` が 72 KB と異常に大きい。 `server/diary.ts` を確認しないと分からないが、
> hourly bucket × 24h × 複数指標 (heartbeat / GitHub / activity) を生のままシリアライズして
> いる可能性大。 **集計後の数字だけ残せば 5-10 KB に減らせる余地がある**。

**3 シナリオ別 (現状の 80 KB/row 前提):**

| シナリオ | rows/day | bytes/year | 5 年 | 10 年 |
|---------|---------:|-----------:|----:|----:|
| 1 日 1 行 (現状)            | 1 | 28 MB | 142 MB | 285 MB |
| 1 日 1 行 + metrics 圧縮    | 1 |  3 MB |  17 MB |  35 MB |

→ 行数は少ないが、 **1 行が太いせいで 10 年で 285 MB に到達**。
→ `metrics_json` のスキーマ見直しが最も投資対効果が高い。

### 3a.6 `page_visits` (集約テーブル、 念のため)

**実測:**

- 931 行 / 168 KB / 181 bytes/row
- **upsert** なので新 URL のみ追加 (再訪は visit_count++)
- 1 日新規 URL: 14-79 (実測)
- max visit_count = 439 (= Gmail 等を 1 行で 439 回とカウント)

**試算:** 1 日新規 50 URL × 365 日 × 5 年 = 91K 行 / 16 MB → **10 年でも 33 MB**。
集約構造のおかげで成長率が **page_visits の visit_count に逃げる** ので、 ほぼフラット化する。

→ 心配なし。

### 3a.7 ヘビーテーブル合計予測 (実測 + ミドルシナリオ)

| Table | 5 年 | 10 年 | %  |
|-------|----:|----:|---:|
| `activity_events` (claude+git, ミドル)   |  380 MB | 750 MB | 42% |
| `gps_locations` (圧縮 ON)                |   31 MB |  62 MB |  3% |
| `visit_events` (90 日リテンション)       |    9 MB |  18 MB |  1% |
| `dig_sessions` (raw_json リテンション)   |   35 MB |  70 MB |  4% |
| `diary_entries` (現状 metrics_json)      |  142 MB | 285 MB | 16% |
| `bookmarks` 等その他                     |  300 MB | 600 MB | 34% |
| **DB 全体合計**                          | **~900 MB** | **~1.8 GB** | 100% |

→ 10 年で **1.8 GB**。 SQLite 性能限界 (50 GB+) からまだ 25 倍以上のヘッドルーム。

---

## 3b. もし「raw 全部保存」 にしていたらどうなるか (悪夢シナリオ)

ユーザの懸念に応える形で、 **既に施されている圧縮を全部外した場合** の試算:

| Table | 圧縮 OFF / リテンション無し | 5 年 | 10 年 |
|-------|----:|----:|----:|
| `gps_locations` raw 1500/day              | 0.4 MB/day | 730 MB | 1.5 GB |
| `visit_events` (DNS tap full 500/day)     | 0.06 MB/day | 113 MB | 226 MB |
| `activity_events` (truncate なし、 1KB/row, 1000/day) | 1 MB/day | 1.8 GB | **3.6 GB** |
| `dig_sessions` (raw_json 全保存、 20/day) | 0.13 MB/day | 237 MB | 475 MB |
| `diary_entries` (metrics 72KB/day 現状)   | 0.08 MB/day | 142 MB | 285 MB |
| **合計**                                  | **1.7 MB/day** | **3.0 GB** | **6 GB** |

→ それでも SQLite で動くサイズ。 ただし 5 年目以降は **indexing 補強なしだと
   date 集計が秒台に乗る**。

---

## 3c. 月次パーティションが効く / 効かないテーブル別判定

ユーザの「月次パーティション化」 案に対する個別判定:

| Table | パーティション効果 | 採るべき対策 |
|-------|------------------|------------|
| `activity_events` | △ | **indexing + 90 日超を集計化** が遥かに有効 |
| `gps_locations` | × | 既に圧縮済 (#97)、 古い `raw_json` を NULL 化のみ |
| `visit_events` | △ | **90 日リテンション + 単純 DELETE** が最適 |
| `dig_sessions` | × | 行数自体が少ない、 `raw_results_json` のみ古いものを NULL 化 |
| `diary_entries` | × | 行数 365/year、 **`metrics_json` のスキーマ見直し**が最重要 |
| `bookmarks` | × | upsert、 ユーザ資産そのもの — 削除候補にならない |

→ **どのテーブルもパーティションより別の対策の方が効く**。
→ 強いて言えば `activity_events` だけは将来 ATTACH 分離の余地があるが、
   indexing + retention で 10 年 3.6 GB → 800 MB に絞れるので、
   **個人 PC 用途では月次パーティションは過剰**。

---

### 4.1 理論限界 (better-sqlite3 + WAL)

| 項目 | 限界 |
|------|------|
| ファイルサイズ | 281 TB |
| 1 テーブルの行数 | 2^64 (実用上無制限) |
| 1 行のサイズ | 1 GB (BLOB/TEXT) |
| index/page サイズ | 64 KB ページ |

### 4.2 実用域での性能 (better-sqlite3, 個人 PC, NVMe SSD 想定)

ベンチマーク的な目安 (公式 + コミュニティ実測):

| シナリオ | レイテンシ目安 |
|---------|---------------|
| index 付き SELECT (1 行) | < 0.1 ms (~10万 qps) |
| index 付き範囲 SELECT (100 行) | < 1 ms |
| 全表 COUNT (100万行) | 50-200 ms |
| 全表 COUNT (1000万行) | 500 ms-2 s |
| 単発 INSERT (synchronous=FULL) | 1-3 ms |
| 単発 INSERT (synchronous=NORMAL, WAL) | 0.05-0.2 ms |
| トランザクション内 1万 INSERT | 50-200 ms |

### 4.3 Memoria での想定クエリ負荷

主要なホットパスはほぼ全部 indexed:

- `bookmarks` 一覧 (50 件ページング、`/api/bookmarks`): `created_at DESC LIMIT 50` → **1 ms 未満**
- `activity_events` 当日分: `WHERE date(occurred_at,'localtime') = ?` →
  - 行数 1500 → 数 ms
  - 行数 1万 (8 日分) → 30-50 ms
  - 行数 10万 → 200-500 ms 。 indexed でないので **ここが最初のボトルネック**
- `page_visits` ドメイン別集計 (`/api/domains`): SUM with GROUP BY → **数 ms** (現サイズ)
- 日記の dig 取得: `dig_sessions WHERE date(created_at,'localtime') = ?` → 数 ms

→ **`activity_events` が 5-10 万行を超えるあたりから date 集計が秒単位になりはじめる**。
これは概ね **1-2 年後** に到達。 ただし indexed にすればさらに 100 倍速くなる余地あり (§7.1)。

---

## 5. パーティションの是非

### 5.1 月次パーティションの選択肢

SQLite には built-in パーティショニングがない。 取りうる方法:

| 方法 | メリット | デメリット |
|------|---------|------------|
| (a) ATTACH DATABASE で月別ファイル | ホット/コールド分離、 個別 vacuum 可 | クロスファイル JOIN 不可、 集計が UNION 地獄、 transactional 一貫性の運用負担 |
| (b) 1 DB 内テーブルを月別に分割 (`activity_events_202605` 等) | クロステーブル UNION で集計可 | 月跨ぎの sweeper / migration / index 維持コストが累積、 schema 進化が極端に重い |
| (c) パーティションテーブル (sqlite-vss 等の拡張) | 透過的 | 採用拡張が外部依存、 better-sqlite3 と相性問題 |

### 5.2 結論: パーティションは過剰

理由:

1. **DB 全体が 5 年で 1-2 GB**。 SQLite が苦しむ規模は 50 GB 超えから。 50 倍のヘッドルームがある
2. **書込み頻度のピーク (Claude Code hook = ~1500 row/min)** でも、 better-sqlite3 の WAL モードでは
   1 トランザクションあたり 1ms 未満で捌ける。 既に POST `/api/activity/event` は durationMs 1 のログが
   並んでいる (実測)
3. 月別ファイルにすると、 「先月の commit + 今月の prompt をまとめて表示」 のような **作業ログタブの
   日次グルーピング** ができなくなる。 まさに今日追加した機能と相性が悪い
4. backup 戦略 (data/ 丸ごと) も複雑化

---

## 6. 代わりに採るべき対策 (推奨度順)

### 6.1 ★ 推奨: indexing の補強

`activity_events` の現スキーマ確認 → **`(date(occurred_at,'localtime'), kind)` 相当の generated column + index** を入れる。

```sql
ALTER TABLE activity_events ADD COLUMN occurred_date TEXT
  GENERATED ALWAYS AS (date(occurred_at,'localtime')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_activity_events_date_kind
  ON activity_events(occurred_date, kind, occurred_at DESC);
```

- 効果: `activityEventsPage(db, dateStr, { kind })` が **行数に依存しない O(log N)** になる
- 1 日 1500 行 × 10 年 ≒ 550 万行でもページング数 ms

### 6.2 ★ 推奨: WAL checkpoint の明示化

```js
// 起動時 + 1 時間に 1 回
db.pragma('wal_checkpoint(TRUNCATE)');
```

WAL が 4 MB に膨らんでいるのは autocheckpoint が走っていない可能性。
TRUNCATE モードで強制 checkpoint すれば WAL は数 KB に戻る。

### 6.3 ☆ 中期: リテンション + 集計テーブル

5 年運用後を見据えて、 **古い詳細を集計に置き換える** sweeper を入れる。
パーティションより遥かにシンプル。

```js
// 90 日超の activity_events は、 日次集計テーブル `activity_daily` に移してから DELETE
//   (date, kind, source) → (count, first_occurred, last_occurred, sample_content)
// retention 適用は手動 or 月 1 cron
```

| 対象 | リテンション | 集計後の保存形式 |
|------|------|------|
| `activity_events` | 90-180 日 | (date, kind, repo/source, count) |
| `visit_events` | 90 日 | 既存 `page_visits` に集約済 → 単純削除 |
| `accesses` | 365 日 | 必要なら月次 (date, bookmark_id, count) |
| `server_events` | 90 日 | downtime のみ保持、 start/stop は削除 |
| `gps_locations` | 365 日 | (date, place_id, dwell_minutes) に圧縮 |

10 年スパンで 2 GB → 200-300 MB に削減可能。

### 6.4 ☆ 任意: VACUUM の運用

```js
db.exec('VACUUM;');  // 月 1 回手動 or 起動時、 運用負担小
```

DELETE の後に走らせるとファイルサイズが回復する。
ただし VACUUM 中は exclusive lock がかかるので、 stop-the-world になる
(数百 MB なら数秒、 1 GB なら 10 秒オーダー)。

### 6.5 (将来) Multi-Hub への移行

`docs/multi-server-architecture.md` の Local/Multi 二層化 (#34) で **Multi 側は Postgres**。
共有データの規模が肥大したら Hub に逃がせる構造になっている。
個人 Local DB は依然 SQLite で問題なし。

---

## 7. 期間別ロードマップ提案

| 時期 | 対応 | 理由 |
|-----|------|------|
| **今すぐ (Issue 化推奨)** | indexing 補強 (§6.1) + WAL checkpoint (§6.2) | コスト数行、 効果絶大 |
| **DB が 100 MB 超えたら** | 月 1 VACUUM + リテンション設計 (§6.3) | 100 MB が「個人 PC でも体感する」 ライン |
| **DB が 1 GB 超えたら** | リテンション実装、 sweeper を別 cron に分離 | 検索体感が 100ms 単位になり始める |
| **DB が 10 GB 超えたら** | activity_events を ATTACH 分離、 もしくは全面 Postgres 移行検討 | SQLite でも動くが backup / vacuum の運用負担が無視できなくなる |

→ 現在のペースだと **「DB 100 MB 超え」 は約 4 ヶ月後 ≈ 2026-09**、
**「1 GB 超え」 は約 4 年後 ≈ 2030**。 月次パーティションを今入れる理由はない。

---

## 8. 補遺: 計測手順 (再現用)

```bash
# 行数 + dbstat ベースサイズ (read-only で安全)
cd E:/Document/Ars/Memoria/server
node -e "
import('better-sqlite3').then(({default:Database})=>{
  const db = new Database('../data/memoria.db', { readonly: true });
  for (const {name} of db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all()) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM \"'+name+'\"').get().n;
    let bytes = null;
    try { bytes = db.prepare('SELECT SUM(payload) AS b FROM dbstat WHERE name=?').get(name).b; } catch {}
    console.log(name, n, bytes);
  }
});
"

# WAL 状態
sqlite3 data/memoria.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

---

**まとめ:** 月次パーティションの導入価値は現時点で **無し**。 代わりに indexing 補強 +
WAL checkpoint + 1-2 年スパンでリテンション運用を整える方針が、 5-10 倍コスト効率がよい。
