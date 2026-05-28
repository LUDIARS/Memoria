# hub-aggregation — Hub の横断データ集約サーバ層

> Memoria Hub のサーバサイド設計。 **複数 LUDIARS アプリのデータを横断的に
> 集約して 1 つの API として出す層**を扱う。
> 関連:
> - [`multi-hub.md`](./multi-hub.md) — Hub の **データハブ役** (Memoria 自身の共有 7 型)
> - [`hub-shell.md`](./hub-shell.md) — Hub の **frontend shell 役** (アプリ集約レンダリング) + dataChannel 概念
>
> 本書はこの 2 つの隙間 — 「Memoria 以外の LUDIARS アプリ (Actio / Schedula /
> Aedilis / Bibliotheca 等) のデータをサーバ側で集約する仕組み」 を設計する。

## 1. 背景と位置づけ

### Hub の 3 つの層

| 層 | 役割 | 既存設計 | 本書 |
|---|---|---|---|
| データハブ | Memoria 自身の共有 7 型を Postgres で集中保持 | multi-hub.md | — |
| **横断集約** | **他 LUDIARS アプリのデータを横断 API として束ねる** | **なし** | **本書** |
| frontend shell | 複数アプリの UI を 1 画面に集約レンダリング | hub-shell.md | — |

hub-shell.md §8 は dataChannel (`task` 等) という**概念**を定義したが、
「実装 (channel mediation / sync) は Phase 1 以降」 と明記し**サーバ実装は未設計**。
本書がその channel mediation のサーバ層を設計する。

### なぜ必要か (5月目標との関係)

5月集中目標 1 =「**Hub で Bibliotheca と Actio が動作する**」。 hub-shell が UI を
集約しても、 各アプリは別オリジンの独立サービスのまま。 「Hub で動く」 を実用に
するには:

- **横断ダッシュボード** — Hub のホームで「今日の予定 (Schedula) + タスク (Actio)
  + 貸出中の本 (Bibliotheca)」 を 1 画面に出す
- **dataChannel interop** — Memoria の AI 委託 UI が Actio のタスクを直接読む
  (hub-shell §8 の task channel)

どちらもサーバ側で他アプリの API を叩いて束ねる層が要る。 それが本書。

## 2. 用語

- **集約ゲートウェイ (Aggregation Gateway)** — Hub backend 内の、 他アプリ API を
  呼び出して結果を束ねるサブシステム。 実装は `server/multi/aggregation/`
- **ソースアプリ (Source App)** — 集約対象の LUDIARS アプリ (Actio / Schedula 等)。
  hub-shell.md の Mounted App と同一集合だが、 こちらは **API** を見る
- **dataChannel** — アプリ間で扱う共通データ種別 (`task` / `event` / `reservation`
  / `loan` 等)。 hub-shell.md §8 で定義。 本書はそのサーバ実装
- **provider / consumer** — channel に対する役割。 provider = 権威ストア、
  consumer = 読む側 (hub-shell §8.2)
- **federation (連合)** — Hub がデータを保持せず、 都度ソースアプリへ問い合わせて束ねる方式

## 3. 集約方式の決定

「他アプリのデータをどう束ねるか」 で 3 案。 決定指標は LUDIARS 標準軸
(AI 学習量 / 作業コスト / 解決度 / 主目的との一致度。 主目的 =「横断データを
正しく・新鮮に・安全に出す」)。

### A. ライブ federation (都度連合)

Hub はデータを一切保持しない。 リクエストの度に各ソースアプリ API へ
fan-out → 正規化 → マージして返す。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★☆☆ — fan-out / 正規化 / 部分障害ハンドリング |
| 作業コスト | 小〜中 — ストア・同期・migration 不要 |
| 解決度 | ★★★★☆ — 常に最新。 ただしクロスアプリの重い集計クエリは苦手 |
| 主目的一致度 | ★★★★★ — データはソースに留まり[個人データ保管禁止]に抵触しない |

### B. マテリアライズ同期 (キャッシュ蓄積)

Hub が各アプリのデータを定期 pull して Postgres に複製、 そこから出す。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★★☆ — 同期エンジン / 差分検知 / conflict |
| 作業コスト | 大 — スキーマ・migration・同期 worker・staleness 管理 |
| 解決度 | ★★★☆☆ — 高速だが stale。 障害時も古いデータは出せる |
| 主目的一致度 | ★★☆☆☆ — **他アプリのユーザデータを Hub DB に複製する** = 個人データ保管禁止に抵触 |

### C. ハイブリッド (federation + 短命キャッシュ)

既定は A。 ホット経路のみ in-memory の短命キャッシュ (TTL 数十秒) を挟み、
ソースアプリからの webhook で invalidate。 **永続ストアは持たない**。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★★☆ |
| 作業コスト | 中 — A + キャッシュ層 + webhook 受口 |
| 解決度 | ★★★★★ — 新鮮さと速度を両立 |
| 主目的一致度 | ★★★★★ — 永続複製しないので個人データ保管禁止を満たす |

### 推奨: **A を基本、 性能要件が出たら C へ拡張**

- **A (ライブ federation) を v0.1 の既定**にする。 各アプリが権威、 Hub は束ねるだけ。
  個人データ保管禁止 ([[project_personal_data_rule]]) を構造的に守れる
- B は採らない — 他アプリのユーザデータを Hub Postgres に複製するのは
  単一情報源原則に反する。 Hub Postgres は multi-hub.md の Memoria 自身の
  7 型専用に留める
- 体感速度の問題が顕在化したら C の in-memory 短命キャッシュ (永続化しない) を足す。
  v0.1 では持たない

> 区別の明確化: **Memoria 自身の 7 型 = Hub Postgres に集中保持 (multi-hub.md)**。
> **他アプリのデータ = 集約ゲートウェイが federation で都度取得、 保持しない (本書)**。

## 4. アーキテクチャ

```
                 ┌──────────── Memoria Hub (拠点サーバ) ────────────┐
                 │                                                   │
  Hub Shell SPA ─┼─► /api/agg/*  (集約ゲートウェイ)                   │
  (hub-shell.md) │        │                                          │
                 │        ├─ channel registry  (manifest 由来)        │
                 │        ├─ source client pool (per app)             │
                 │        ├─ token broker  (per-user × per-app)       │
                 │        └─ normalizer  (canonical schema 変換)       │
                 │             │                                      │
                 │   /api/data/*  (multi-hub.md: Memoria 7 型 / PG)    │
                 └─────────────│────────────────────────────────────┘
                               │  fan-out (Bearer: project-token)
            ┌──────────────────┼──────────────────┬─────────────┐
            ▼                  ▼                  ▼             ▼
         Actio             Schedula            Aedilis      Bibliotheca
       /api/tasks         /api/events       /api/reservations  /api/loans
        (task)             (event)           (reservation)     (loan)
```

集約ゲートウェイの内部:

| サブ要素 | 責務 |
|---|---|
| channel registry | どの channel をどのアプリが provider/consumer として宣言したか (manifest `dataChannels` 由来)。 `hub_apps` テーブル (hub-shell §9.3) から構築 |
| source client pool | アプリごとの HTTP クライアント。 base URL は manifest の origin、 タイムアウト・リトライ・circuit breaker を持つ |
| token broker | リクエストユーザの Cernere コンテキストから、 対象アプリ用 project-token を発行・キャッシュ (§6) |
| normalizer | 各アプリの生レスポンスを channel の canonical schema (hub-shell §8.3 等) に変換 |

## 5. dataChannel のサーバモデル

### 5.1 channel 定義

channel は Hub 側の静的定義 + アプリ manifest の宣言で決まる。

- **canonical schema** — channel ごとの正規レコード形。 Hub が保持する静的定義。
  task の canonical schema は hub-shell.md §8.3。 event / reservation / loan は §9
- **provider 集合** — manifest で `{ name: <channel>, role: "provider" }` を出した
  アプリ群
- **consumer 集合** — `role: "consumer"` を出したアプリ群

### 5.2 読み取り (consumer → channel)

```
GET /api/agg/<channel>?from=&to=&filter=
  1. channel registry から provider 一覧を引く
  2. 各 provider に並行 fan-out (token broker が project-token を付与)
  3. 各レスポンスを normalizer で canonical schema に変換
  4. マージ (id 衝突は source 名で名前空間化: "<source>:<id>")
  5. 部分障害: 落ちた provider は results から除外し meta.partial に記録
  6. { items, meta: { sources: [...], partial: bool } } を返す
```

### 5.3 書き込み (consumer → channel)

書き込みは**必ず権威 provider に届ける**。 multi-provider channel では
`source` フィールド (または明示の `targetApp`) で宛先を決める。

```
POST /api/agg/<channel>     body に source 指定 → その provider の API へ転送
PATCH /api/agg/<channel>/<source>:<id>   → source の provider へ
DELETE /api/agg/<channel>/<source>:<id>  → 同上
```

Hub は書き込みを**中継するだけ**で、 結果の保持はしない。

### 5.4 単一 provider の最適化

channel に provider が 1 つだけのとき (例: task channel で「Actio 一元化」 を
採った場合、 provider は Actio のみ) は fan-out せず単純 proxy になる。
実装は同じコードパスで provider 数 1 として処理。

## 6. 認証 — Hub による project-token ブローカリング

Hub が他アプリ API を叩くには、 **そのユーザとして** 認証する必要がある。

- ユーザは multi-hub.md §5.2 のフローで Hub にログイン済 → Hub はそのユーザの
  Cernere accessToken (または project-token) を **process memory に保持**
  (multi-hub.md §8、 [[feedback_secret_per_user_memory_only]])
- 集約ゲートウェイがアプリ X を呼ぶ際、 token broker が Cernere
  `/api/auth/project-token` で **per-user × per-project(=X)** の project-token を
  発行 ([[feedback_cernere_auth_only_endpoints]])
- project-token は **process memory のみ**にキャッシュ (TTL は token の exp に従う)。
  Hub Postgres にもファイルにも書かない
- アプリ X 側は受け取った project-token をローカル HMAC 検証 (各サービスの既定方式)

> Hub session token (multi-hub) と project-token (集約用) は別物。 前者は
> ローカル Memoria ↔ Hub、 後者は Hub ↔ ソースアプリ。

## 7. Hub 集約 API

すべて `/api/agg/*`、 Hub session 認証必須 (multi-hub.md の session token)。

| method | path | 説明 |
|---|---|---|
| GET | `/api/agg/channels` | 有効な channel 一覧と各 provider/consumer |
| GET | `/api/agg/<channel>` | channel の横断取得 (§5.2)。 query: `from`/`to`/`filter`/`limit` |
| GET | `/api/agg/<channel>/<source>:<id>` | 1 件取得 |
| POST | `/api/agg/<channel>` | 作成 (権威 provider へ中継、 §5.3) |
| PATCH | `/api/agg/<channel>/<source>:<id>` | 更新 |
| DELETE | `/api/agg/<channel>/<source>:<id>` | 削除 |
| GET | `/api/agg/home` | 横断ダッシュボード用サマリ (§8) |

エラー形式は `{ error, code }` 統一。 provider 部分障害は 200 + `meta.partial`。

## 8. Hub Home — 横断ダッシュボード

`GET /api/agg/home` はログインユーザの**当日の横断サマリ**を 1 レスポンスで返す。
hub-shell の Hub ホーム画面が消費する。

```jsonc
{
  "date": "2026-05-21",
  "widgets": [
    { "channel": "event",       "source": "schedula",    "title": "今日の予定",   "count": 3, "items": [/* 直近数件 */] },
    { "channel": "task",        "source": "actio",       "title": "未完了タスク", "count": 7, "items": [/* due 近い順 */] },
    { "channel": "reservation", "source": "aedilis",     "title": "施設予約",     "count": 1, "items": [/* ... */] },
    { "channel": "loan",        "source": "bibliotheca", "title": "貸出中",       "count": 2, "items": [/* ... */] }
  ],
  "meta": { "partial": false, "unavailable": [] }
}
```

- どの widget を出すかは登録済 `hub_apps` の `dataChannels` から動的決定
- アプリ未起動・未登録なら該当 widget を省略 (`meta.unavailable` に記録)
- 各 widget は §5.2 の federation を内部で使う

## 9. channel カタログ

v0.1 で定義する canonical channel。 task 以外は本書で新規定義。

| channel | canonical schema | provider | consumer |
|---|---|---|---|
| `task` | hub-shell.md §8.3 | Actio | Memoria (AI 委託 UI) |
| `event` | `{ id, source, title, startAt, endAt, location?, ownerUserId }` | Schedula | Hub Home / Aedilis |
| `reservation` | `{ id, source, facilityId, facilityName, startAt, endAt, state, ownerUserId }` | Aedilis | Hub Home |
| `loan` | `{ id, source, itemKind, itemTitle, borrowedAt, dueAt?, state, ownerUserId }` | Bibliotheca | Hub Home |

- 各 channel は 1 provider から開始。 将来 multi-provider 化 (例: `event` に
  Google Calendar を足す) しても §5.2 の fan-out がそのまま効く
- `event` は Aedilis が consumer にもなる (施設予約時に空き判定で予定を読む) —
  ただし Aedilis ↔ Schedula は Aedilis DESIGN.md §3 の直結 API が既にあるため、
  Hub 集約経由は Hub Home 表示用に限る

## 10. プライバシー

- 集約ゲートウェイは**他アプリのユーザデータを永続化しない** (§3 推奨 A)。
  federation の通過点であり、 ストアではない
- project-token は process memory のみ ([[feedback_secret_per_user_memory_only]])
- `meta` / ログにユーザデータ本文を出さない。 ログは channel 名・source 名・
  件数・所要時間まで
- 個人ログ系 (diary / GPS / meals 等) は channel 化しない。 channel はアプリ間で
  共有意図のあるドメインデータに限る (multi-hub.md §4 と同方針)

## 11. 実装フェーズ

| Phase | 内容 |
|---|---|
| 1 | `server/multi/aggregation/` scaffold。 channel registry + source client pool + token broker。 `task` channel を単一 provider (Actio) で federation |
| 2 | `event` channel (Schedula provider)。 `GET /api/agg/home` の task+event widget |
| 3 | `reservation` (Aedilis) / `loan` (Bibliotheca) channel。 Hub Home 4 widget 完成 |
| 4 | C 案の in-memory 短命キャッシュ + ソースアプリ webhook invalidate (性能要件が出たら) |
| 5 | multi-provider channel 対応の検証 (`event` に Google Calendar 追加 等) |

Phase 1-3 で 5月目標 1 の「Hub で動作」 のデータ面が満たせる。
hub-shell.md の frontend 実装 (mount loader / shell SPA) と並走する。

## 12. オープン論点

1. **channel 定義の所在** — canonical schema を Hub 側静的定義にするか、
   各アプリ manifest に schema 参照を持たせるか
2. **書き込みの consumer 制限** — consumer からの write をどこまで許すか
   (task は Memoria→Actio 書き戻しを許す想定だが channel ごとに要判断)
3. **Hub Shell が無い軽量利用** — frontend shell を使わず `/api/agg/*` だけ
   叩くクライアント (CLI / 他サービス) を許すか
4. **LUDIARS Shell 分離時の扱い** — hub-shell.md §6 の分離時、 集約ゲートウェイも
   一緒に LUDIARS Shell へ移すか (frontend と対で動くため移すのが自然)
