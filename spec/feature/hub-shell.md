# hub-shell — Memoria Hub に LUDIARS アプリ群を集約する frontend shell

> このドキュメントは Memoria Hub に **複数 LUDIARS アプリを一つのフロントエンド
> として集約する shell 機能** を載せる方向性の **準備段階の設計書**。
> 実装はまだ開始しない (= 「準備だけする」 段階)。
> 関連: [`multi-hub.md`](./multi-hub.md) (データハブ側の既存設計)

## 1. 背景と狙い

### 現状

Memoria Hub (`server/multi/`) は Postgres を持ち、 共有 7 型 (bookmarks / digs /
dictionary / implementation-notes / work-locations / domain-catalog / notes) の
JSON CRUD を出す **データハブ**。 UI は setup/login の 2 ページのみで、
本来の Memoria UI はローカル frontend (`server/index.ts` の Hono static + Electron) が
持つ。

他の LUDIARS アプリ (Actio / Calicula / Bibliotheca / Quaestor / Praeforma /
Hora / Susurrus / Ludellus 等) はそれぞれ独自に Web フロントエンドを持っており、
ユーザは複数の URL / Tauri アプリを跨いで使う必要がある。

### 狙い

- 複数 LUDIARS アプリを **Memoria Hub 上で集約レンダリング** する shell を持つ
- レンダリングは shell が **一貫した design system (Foundation UI) で** 行う
  ことでアプリ間の見た目・操作感を統一する
- 集約自体は Memoria 固有機能ではないので、 将来的に **別サービス
  (仮称: LUDIARS Shell)** として切り出す。 が、 実装パターンは変わらないので
  当面は Memoria Hub の中で育てる
- このドキュメントは **Phase 0 = 準備** のスコープのみ確定する

### 非スコープ (このドキュメントでは決めない)

- 各アプリの認証統合 (= Cernere SSO で既に対応済 / アプリごとに別途検討)
- 各アプリの API gateway / reverse proxy 化
- 既存 Memoria UI そのものの再実装
- 「データハブ」 側機能 ([`multi-hub.md`](./multi-hub.md)) との関係整理 (= Phase 1 で扱う)

### Phase 0 (準備) 段階で **明示的に取り込む** 要件

ユーザ指示で確定した、 準備の段階で仕様に盛り込んでおく要件:

1. **集約ナビは「役割が読める」タブ形式**。 アプリ名だけでなく、 そのツールが
   何をするものかを短い説明で添える。 詳細は §4.2。
2. **タスクは Actio と統合可能にしておく**。 Memoria task 機能と Actio task
   機能を Hub Shell 上で同じデータとして扱える設計の土台を作る。 詳細は §8。
3. **タブは Cernere のプロジェクトリストから自動生成**。 ユーザの手順は
   「Cernere にログイン」 だけ。 Hub が Cernere `managed_project.list` を
   引いて、 各プロジェクトの manifest 公開を probe し、 取れたものを
   タブ化する。 admin による手動追加 (Cernere 未登録の試験アプリ用) も
   サポートする。 詳細は §9。

## 2. 用語

- **Hub Shell** (本ドキュメントの主役): Memoria Hub に載る、 複数アプリを
  集約する frontend shell
- **集約対象アプリ** / **Mounted App**: Hub Shell の中に組み込まれる
  LUDIARS アプリ (Actio / Bibliotheca 等)
- **App Manifest**: 各アプリが Hub Shell に提示する metadata
  (表示名 / icon / route / 必要 capability 等)。 静的 JSON または config 経由
- **App Registry**: Hub Shell が知っている Mounted App の集合。 起動時に
  manifest を集めて nav に並べる

## 3. 集約方式の選択肢

「Hub がレンダリングを行う」 をどこまで厳密にとるかで 3 案。 決定指標は
ユーザ環境の標準軸: **(1) AI 学習量 / (2) 作業コスト / (3) 解決度 /
(4) 主目的との一致度** (主目的 = 「一貫した frontend で集約」)。

### A. iframe 方式

各アプリの既存 frontend を `<iframe>` で読み込み、 Hub Shell は chrome
(nav / 認証 / theme) だけ提供。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★☆☆☆☆ (既存 iframe 周りのコモディティ知識) |
| 作業コスト | 低 — 各アプリの frontend に手を入れずに済む |
| 解決度 | ★★☆☆☆ — chrome は統一されるが、 中身は各アプリの素の UI そのまま |
| 主目的との一致度 | ★★☆☆☆ — 「一貫レンダリング」 ではなく 「一貫ナビ」 にしかならない |

### B. micro-frontend 方式 (Web Components / Module Federation)

各アプリが Hub Shell に **mount 可能なバンドル** (Web Component, ESM module,
Module Federation の remote 等) を公開し、 Hub Shell が動的 import して
shell 内に直接マウントする。 design system (Foundation UI) は shell が提供し、
各アプリは shell から CSS variable / Tailwind preset を受け取って描く。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★★☆ (Module Federation / WC / build pipeline で得るものは多い) |
| 作業コスト | 中 — 各アプリの frontend を 「shell に渡せる単位」 にリパッケージ。 build 設定の追加 |
| 解決度 | ★★★★☆ — shell が CSS / theme / nav を握り、 中身も DOM 上は単一木 |
| 主目的との一致度 | ★★★★★ — 「Hub がレンダリング」 を文字通り満たす |

### C. shell が再実装方式

各アプリの API のみを使い、 UI は Hub Shell が自前 React/Vanilla SPA で
全部書く。 各アプリの既存 frontend は (Hub Shell 経由では) 使わない。

| 指標 | 値 |
|---|---|
| AI 学習量 | ★★★☆☆ (個別アプリの再実装は反復作業に近い) |
| 作業コスト | 大 — 集約対象が増えるごとに UI 全部書き直し。 各アプリの仕様変更に追随必要 |
| 解決度 | ★★★★★ — 完全に統一 |
| 主目的との一致度 | ★★★★☆ — 一貫だが、 各アプリの実装と二重管理 |

### 推奨: **B (micro-frontend)**

- 「Hub がレンダリングを行う」 主目的を最も正確に満たす
- C と比べて二重実装にならない (各アプリの frontend を mount 可能形に
  リパッケージするだけで済む)
- A よりも「一貫レンダリング」 が deep に効く (CSS / theme / DOM が共通)
- 将来 Hub Shell が別サービスに分離しても、 同じ mount API でそのまま使える

ただし B は build pipeline の選択 (Web Components vs Module Federation
vs UMD) が一段未確定。 これは **Phase 0 の Decision-1 として確定する** (§5)。

## 4. App Manifest (準備)

### 4.1 manifest フィールド

集約対象アプリは Hub Shell に対し以下の manifest を提示する。 形式は
JSON、 配信は (a) 各アプリの `/.well-known/ludiars-app.json` または
(b) Hub の `apps.json` 静的設定の 2 経路を想定する (Phase 0 では仕様だけ確定)。

```jsonc
{
  "id": "bibliotheca",            // 短い不変 ID (URL でも使う)
  "displayName": "Bibliotheca",   // タブのアプリ名
  "description": "蔵書・機材の貸出台帳",  // タブの役割行 (必須、 §4.2)
  "shortCode": "Bb",              // LUDIARS の 2 文字略称
  "icon": "📚",                   // emoji or relative URL to SVG
  "version": "0.1.0",
  "entry": {                       // mount するバンドルの所在
    "type": "web-component",       // 暫定: web-component / esm / module-federation
    "tag": "bibliotheca-app",      // type=web-component の場合
    "url": "https://bibliotheca.example/dist/element.js"
  },
  "capabilities": [                // Hub に要求する権限 (将来用)
    "cernere-session",             // shell から Cernere session を受け取る
    "design-tokens"                // shell の CSS variable を継承
  ],
  "dataChannels": [                // 他アプリと統合するデータ種別 (§8)
    { "name": "task", "role": "consumer" }
  ],
  "routes": [                      // shell の URL 空間でのアプリの場所
    { "path": "/apps/bibliotheca", "default": true }
  ]
}
```

Phase 0 ではこの schema 定義だけ確定 + JSON schema ファイル化する。
動的 fetch / 検証ロジックは Phase 1 以降。

### 4.2 タブ UX (役割の見せ方)

集約ナビは **タブ形式**。 タブ 1 個に以下 3 要素を必ず出す:

| 要素 | 出どころ (manifest) | 用途 |
|---|---|---|
| アイコン | `icon` | 視覚的識別 (emoji 1 字 or SVG) |
| アプリ名 | `displayName` | 「Memoria」「Actio」 等 |
| **役割 (description)** | `description` | 「ナレッジ管理」「予定・タスク管理」 等の 1 行説明 |

`description` は **必須**。 タブ表示で常に見える状態にすることでユーザが
「どのタブが何のためのものか」 を覚えていなくても辿り着ける。

レイアウトイメージ (1 タブ):

```
┌──────────────────────────────┐
│  📓  Memoria                 │
│      ナレッジ管理             │
└──────────────────────────────┘
```

- 横幅に余裕がある画面 (デスクトップ等): 上記の **アイコン + 名前 + 役割** を
  並べた縦 2 行のタブ
- 狭い画面 (モバイル等): アイコン + 名前のみ、 役割は active タブ下に
  サブタイトルとして 1 行表示

`description` の文字数指標: 全角 6〜14 文字。 schema で `maxLength: 40` を
強制し、 タブの幅が破綻しないようにする。

## 5. Phase 0 (準備) の成果物

このドキュメント自身を含め、 以下を準備フェーズの成果物とする。
**実装コード (mount loader / shell SPA) は Phase 1 から**。

| # | 成果物 | パス | 状態 |
|---|---|---|---|
| 0-1 | hub-shell 設計書 (本ドキュメント) | `spec/feature/hub-shell.md` | ✅ 本 PR |
| 0-2 | App Manifest の JSON schema (description / dataChannels 含む) | `spec/interface/schema/ludiars-app-manifest.schema.json` | 本 PR で stub 作成 |
| 0-3 | Decision-1: バンドル方式 (WC / ESM / MF) の確定 | この doc の §3 を更新 | 別 PR (検証込み) |
| 0-4 | Hub Shell の置き場所 scaffold | `server/multi/shell/` (空 dir + README) | 本 PR で placeholder |
| 0-5 | shell が想定する apps の暫定リスト (description + task channel 入り) | `server/multi/shell/apps.example.json` | 本 PR で placeholder |
| 0-6 | 既存 `multi-hub.md` (データハブ) との関係追記 | `spec/feature/multi-hub.md` の §1 末尾 | 本 PR で 1 段落追記 |
| 0-7 | task channel の interop 契約 (§8) | この doc の §8 | ✅ 本 PR |
| 0-8 | self-registration 仕様 (§9) — Cernere project list → manifest probe → 保存 | この doc の §9 | ✅ 本 PR |
| 0-9 | LUDIARS App Manifest well-known エンドポイント例 | `server/multi/shell/well-known.example.json` | 本 PR で placeholder |
| 0-10 | Hub apps レジストリ DB スキーマ案 (source / cernere_key 含む) | `server/multi/shell/registry.schema.sql` | 本 PR で placeholder (実 migration 化は Phase 1) |
| 0-11 | Cernere 側 `managed_project.list` に `frontendUrl` 露出 | Cernere PR | 別 PR で実装 (DB 変更なし、 派生フィールドのみ) |

## 6. 将来の分離 (LUDIARS Shell 化)

集約 shell は Memoria 固有機能ではないので、 安定したら別リポ
**LUDIARS Shell** (短縮コード未定) として切り出す予定。 そのために
Phase 0 から以下を守る:

- shell の実装は `server/multi/shell/` 配下に閉じる
  (Memoria の他コードと依存を作らない)
- App Manifest / Mount API は Memoria に依存しない汎用 schema にする
- Hub 認証 (Cernere SSO) も Memoria 固有ではないので分離容易

切り出し時に Memoria は「Mounted App の一つ」 になる。

## 7. 未決事項 (Phase 0 内で詰めるもの)

- (a) バンドル方式 (§3 Decision-1)
- (b) 認証 propagation — Cernere session token を shell → mounted app に渡す
  経路 (postMessage / shared cookie / shadowRoot context)
- (c) routing — shell 側の history と mounted app の history の合成
  (例: `/apps/bibliotheca/books/42` がアプリ内 deep link に解決される設計)
- (d) design system 配布 — Foundation UI の CSS variable / Tailwind preset を
  shell 経由で配る (npm package? CDN? inline?)
- (e) task channel の authority 決定 (Memoria / Actio どちらが正 / sync 方向、 §8)
- (f) manifest 改竄/破損時の挙動 (タブを隠す / エラータブ表示 / 自動 disable、 §9.6)
- (g) cross-origin manifest fetch の許可ポリシー (`cernere` source は Cernere 登録 origin を信頼、 `manual` source の許可範囲、 §9.4)

これらは Phase 0 の終わりに別 issue として open する。

## 8. データ統合 — task channel (Memoria ↔ Actio)

### 8.1 現状

- **Memoria** は SQLite に `tasks` を持ち、 AI 委託 / 日記連動 / カテゴリ /
  リマインダー機能を持つ ([`spec/feature/task.md`](./task.md))。 既に
  `POST /api/tasks/:id/share/actio` で **片方向 push** する経路がある
  (Actio の `share_url` に直 POST、 Hub 経由しない)。
- **Actio** は `tasks` テーブル + プラグインアーキテクチャを持つ
  ([`Actio/CLAUDE.md`](../../../Actio/CLAUDE.md))。 status は
  `open / in_progress / blocked / done / cancelled`、 plugin (PM 等) を
  寄せる前提。
- 現状の片方向 share は **Hub Shell とは無関係** の独立経路。 Memoria 側で
  edit しても Actio 側に伝わらず、 Actio で done にしても Memoria 側で
  open のまま、 という不整合がある。

### 8.2 Hub Shell における「task channel」 の位置づけ

Hub Shell は、 アプリ間で扱う共通データ種別を **dataChannel** として manifest で
宣言させる (§4.1)。 task はその最初の channel。

| channel 名 | 内容 | provider 候補 | consumer 候補 |
|---|---|---|---|
| `task` | 「やるべきこと」 単位の項目 (タイトル / 詳細 / status / due) | Actio (core task)、 Memoria (個人 task) | Memoria の AI 委託 UI、 他アプリのタスクウィジェット |

各アプリは manifest で `role` を宣言:

- `"provider"` — この channel の権威ストアを提供する (= 読み書きの正)
- `"consumer"` — 他 provider のデータを読む / 書く (= 自身では権威を持たない)
- `"both"` — 双方向同期する自前ストアも持ちつつ他 provider にも書く

### 8.3 task channel の interop 契約 (Phase 0 で確定する最小スキーマ)

shell mediation を経由して取り回される task のレコード形は以下:

```jsonc
{
  "id": "string",              // channel 内で一意 (provider が発番)
  "source": "actio" | "memoria",  // 発生元
  "externalId": "string?",     // 連動済の場合、 相手側 ID
  "title": "string",
  "details": "string?",
  "status": "open" | "in_progress" | "done" | "cancelled" | "blocked",
  "dueAt": "ISO-8601?",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "ownerUserId": "string"      // Cernere user id
}
```

Memoria の `todo/doing/done` は `open/in_progress/done` にマップ。
Actio の `blocked/cancelled` はそのまま。 Memoria 側に逆輸入する際は
`open` 扱い (Memoria 側のステータス空間が小さい)。

### 8.4 同期方向 (準備段階での提案、 Decision-2)

3 案を decision-metrics で比較 (主目的 = 「タスクが Actio と統合可能」):

| 案 | 概要 | AI 学習量 | 作業コスト | 解決度 | 主目的一致度 |
|---|---|---|---|---|---|
| **i. Actio 一元化** | Memoria は task を持たず、 全部 Actio API を叩く | ★★☆☆☆ | 中 (Memoria 既存 task 機能を Actio バックで再実装) | ★★★★★ | ★★★★★ |
| **ii. 双方向同期** | 双方が自前 store + shell mediation で同期。 externalId で対応付け | ★★★★☆ | 大 (conflict resolution / loop 防止) | ★★★★☆ | ★★★★☆ |
| **iii. 既存 share の改修** | 現 `/api/tasks/:id/share/actio` を pull も含めた API に拡張、 shell は介入しない | ★★☆☆☆ | 小 | ★★★☆☆ | ★★★☆☆ |

**推奨 (準備段階の方針): i. Actio 一元化**

- Actio は既に「予定 + タスク」 のコアプラットフォーム ([`Actio/CLAUDE.md`](../../../Actio/CLAUDE.md))。
  task の権威を Actio に集約する方が責務分担として自然
- Memoria 側の task UI (AI 委託 / 日記連動 / カテゴリ) は shell で
  Actio task channel を consume する形で温存可能
- 個人データ保管禁止ルール (§AIFormat) の観点でも、 task data の単一情報源化は望ましい
- ただし「AI agent_run」 / 「日記の notes 追記」 のような Memoria 固有
  サイドエフェクトは Memoria 側に残るため、 「Actio task に紐付く Memoria
  メタデータ」 という形でローカル拡張テーブルを許す

この方針は **Decision-2** として §7 (e) に上げる。 Phase 1 着手前に確定する。

### 8.5 Phase 0 で準備するもの (task 統合に絞った範囲)

- App Manifest に `dataChannels` フィールドを追加 (4.1 / schema 反映済)
- `apps.example.json` で Actio = `task` provider、 Memoria = `task` consumer
  として宣言 (本 PR)
- 実装 (mount loader / channel mediation / sync) は **Phase 1 以降**

## 9. Self-registration & セットアップ

ユーザは **Cernere に一度ログイン** するだけで Hub に集約タブが揃う構成にする。
Hub backend が Cernere に登録された **managed projects のリスト** を引いて、
各プロジェクトに manifest 公開を probe し、 取れたものだけタブ化する。
ユーザが URL を貼る作業は無くす (§4.2 のタブ説明と組み合わせて
「ログイン → タブが出る」 を達成)。

### 9.1 ユーザフロー

1. **ユーザ**: Hub の login で Cernere SSO ログイン (LUDIARS 既存の OAuth/OIDC)
2. **Hub backend**: Cernere 認証済 WS セッション経由で `managed_project.list` を呼ぶ
3. **Hub backend**: 受け取った各プロジェクトについて、 既に `hub_apps` に登録済か確認
4. **Hub backend**: 未登録のプロジェクトには manifest 公開を **probe** (§9.4)
5. **Hub backend**: probe が成功 (取得 OK + §4 schema 検証 OK) したものだけ `hub_apps` に upsert
6. **Hub backend**: 失敗 / 404 / 5xx / schema NG は skip (登録しない、 警告 log のみ)
7. **Hub frontend**: `hub_apps` から enabled なタブを並べて描画

ユーザ手順は **1 だけ**。 2〜7 は backend が無人で回す。

### 9.2 同期タイミング

| トリガ | 動作 |
|---|---|
| ユーザの Cernere ログイン直後 | フル同期 (全プロジェクト walk + 未登録のみ probe) |
| ユーザの Hub セッション継続中 | 5 分間隔で `managed_project.list` 再取得、 差分のみ probe |
| Cernere から WS push (`managed_project.updated` 等) | 即時、 該当プロジェクトのみ再 probe |
| 管理 UI から手動 `Refetch` | 該当プロジェクトを即 probe |

`managed_project.list` の差分は (a) 新規 `key`、 (b) `is_active` の変化、
(c) `frontendUrl` の更新で検出する。 既存 entry の probe は manifest schema
が薄いため毎回行わず、 上記トリガ + 6 時間毎のローテーション probe のみ。

### 9.3 Cernere 側の要件

Cernere の `managed_projects` には既に `schema_definition.endpoint.frontend_url`
(プロジェクト定義の `endpoint.frontend_url`) があるため、 DB schema 変更は不要。
ただし `managed_project.list` / `overview` の戻り値が現状この値を露出していない
ので、 **派生フィールド** として追加する (実装は Cernere PR で行う):

- `managed_project.list` / `overview` の戻り値に
  `frontendUrl: string | null` を含める
- 値は `schema_definition.endpoint.frontend_url` をそのまま転写
- `frontendUrl` が NULL のプロジェクト (= `endpoint.frontend_url` 未設定) は
  Hub Shell の同期対象外 (= manifest を持たない方針のプロジェクト、
  例: 純 backend サービス)

Hub Shell 側は受け取った `frontendUrl` から origin を派生して probe する:

```ts
const origin = new URL(project.frontendUrl).origin;
const manifestUrl = `${origin}/.well-known/ludiars-app.json`;
```

### 9.4 probe 仕様

Hub backend が走らせる manifest probe の規格:

- **エンドポイント**: `GET <new URL(frontendUrl).origin>/.well-known/ludiars-app.json`
- **timeout**: 5 秒、 **redirect 上限**: 3、 **response 上限**: 256KB
- **差分検出**: `If-None-Match: <last_etag>` 付与、 304 ならスキップ
- **TLS**: HTTPS 必須 (localhost / .local TLD のみ HTTP を許容)
- **SSRF 対策**: private IP (10/8, 172.16/12, 192.168/16, ::1, 127/8) は拒否。
  ただし `MEMORIA_DEV=1` 時のみ localhost 許可
- **検証**: §4 schema で validate、 NG なら登録しない
- **詐称防止**: Cernere の `project.key` と manifest の `id` の一致を確認。
  一致しなければ warn + 登録しない (managed_projects に登録されていない
  origin から自称 id を返されても拒絶)

`Access-Control-Allow-Origin` の確認は Hub backend からの直接 fetch なので不要。
manifest 公開側は CORS ヘッダを返さなくてよい。

### 9.5 admin による override

Cernere に未登録の試験アプリや一時的な停止を扱うため、 admin に以下の手動操作を持つ:

| 操作 | 用途 |
|---|---|
| **手動追加** | Cernere に登録していない任意 URL のアプリを直接登録 (試験用) |
| **Disable** | Cernere 上 active でも Hub タブから外す |
| **Force refetch** | 同期間隔を待たずに即 probe |
| **Reset** | `hub_apps` entry を削除 (次回同期で Cernere から復元される) |

エントリの出自は `hub_apps.source` で区別:

- `source = 'cernere'` — Cernere 由来、 §9.2 の自動同期対象、 元プロジェクトが
  非 active / `frontendUrl` 削除になったら自動 disable
- `source = 'manual'` — admin 手動追加、 自動同期で消えない (手動 remove のみ)

### 9.6 保存スキーマ (Postgres)

Hub の既存 Postgres にテーブル `hub_apps` を追加する (実 migration は Phase 1):

```sql
CREATE TABLE hub_apps (
  id                TEXT PRIMARY KEY,           -- manifest.id
  source            TEXT NOT NULL CHECK (source IN ('cernere','manual')),
  cernere_key       TEXT,                       -- source='cernere' の時 managed_projects.key
  manifest_url      TEXT NOT NULL,              -- fetch 元 (well-known URL or 手動入力)
  manifest_json     JSONB NOT NULL,             -- 最後に取得した manifest 全体
  display_order     INTEGER NOT NULL DEFAULT 0, -- タブの並び順
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  installed_by      TEXT NOT NULL,              -- Cernere user id (cernere source は同期 worker の system uid)
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_etag         TEXT,                       -- 次回 fetch の If-None-Match に使う
  last_error        TEXT,                       -- probe 失敗時の最新エラー (NULL = OK)
  consecutive_failures INTEGER NOT NULL DEFAULT 0  -- 自動 disable 判定用 (§9.7)
);

CREATE INDEX hub_apps_display_order_idx ON hub_apps (display_order, id) WHERE enabled;
CREATE UNIQUE INDEX hub_apps_cernere_key_uniq ON hub_apps (cernere_key) WHERE source = 'cernere';
```

設計メモ:

- `id` (manifest.id) で PK。 同じ id を別 URL から二重登録は弾く
- `manifest_json` を JSONB で保持することで probe 失敗時もタブが消えない
- `cernere_key` UNIQUE (source=cernere) で、 同一 Cernere プロジェクトの重複同期を防ぐ
- `installed_by` は `cernere` source の場合 system uid (例: `system:hub-sync`)、
  `manual` source の場合 admin の Cernere user id
- 個人データ非該当 (manifest は公開情報のみ)、 個人データ保管禁止ルールに抵触しない

### 9.7 fetch サーバプロキシ + admin API

manifest fetch は browser からではなく Hub backend が代理で行う:

```
GET    /api/admin/apps                   → 一覧
POST   /api/admin/apps/preview { url }   → 手動追加用、 fetch + validate のみ
POST   /api/admin/apps          { url }  → 手動追加 (source='manual')
PATCH  /api/admin/apps/:id    { enabled?, display_order? }
POST   /api/admin/apps/:id/refetch       → 該当 entry を即 probe
DELETE /api/admin/apps/:id               → 削除 (cernere source は次回同期で復活)
POST   /api/admin/apps/sync              → Cernere project list 同期を即実行
```

- 仕様 (timeout / redirect / SSRF) は §9.4 と同じ
- 一般ユーザ向け read API (`GET /api/apps`) は別途、 enabled タブのみ返す

### 9.8 認証 & 認可

- 設定 UI 全体は **Cernere 認証 + admin role 必須**
- 一般ユーザは「自動同期で出てきたタブを使う」 のみ
- admin の手動追加 / disable / order 変更も Cernere session 必須
- admin が複数いる場合の競合は last-write-wins (Phase 0 範囲)。 audit log は Phase 1

### 9.9 manifest 破損 / probe 失敗時の挙動

- **schema 検証失敗** (新規): 登録しない、 警告 log
- **schema 検証失敗** (既存): 既存 `manifest_json` を使い続け、 `last_error` 記録 +
  管理 UI に警告バッジ。 `consecutive_failures++`
- **fetch 不能 (404/5xx/timeout)**: 既存 manifest をそのまま使う。
  `consecutive_failures++`
- **連続 3 回失敗で自動 disable** (Phase 0 範囲はこの定数)。 disable 後も
  manifest_json は残り、 復旧時に enable し直せる
- **`entry.url` が dead**: タブ open 時に shell が検知、 ユーザに
  「読み込みに失敗しました」 表示。 タブ自体は隠さない (誤検知防止)
- **Cernere 上で `is_active = false`**: 該当 cernere_key entry を自動 disable
- **Cernere 上で project 削除**: 該当 cernere_key entry を自動 disable
  (Phase 0 では削除しない、 復元可能性のため)

### 9.10 Phase 0 で準備するもの

- 本セクション (仕様確定)
- `well-known.example.json` — Memoria 自身が出す想定形 (変更なし)
- `registry.schema.sql` — §9.6 の `hub_apps` (`source` / `cernere_key` /
  `consecutive_failures` 含む)
- Cernere 側 `managed_project.list` / `overview` への `frontendUrl` 露出 (依存、 別 PR で実装)

実装 (`/api/admin/apps/*` + sync worker + Cernere 統合 + 手動 override UI) は
**Phase 1 以降**。
