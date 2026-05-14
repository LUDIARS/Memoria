# multi — Memoria Hub 連携 API (Local / Multi 二層)

> 設計の全体像は [`spec/feature/multi-hub.md`](../feature/multi-hub.md) を参照。
> 本ページは二層設計の **API 契約**。 旧 OAuth-dance / share-relay 方式の
> エンドポイントは「移行期間中の旧経路」 として末尾にまとめてある (Phase 6 で撤去予定)。

## 1. 概要

- ローカル frontend は常に local backend (`:5180`) に話す。
- **Local モード**: local backend は SQLite 直アクセス。
- **Multi モード**: local backend が Multi 対応 7 型の既存 endpoint を
  Hub の `/api/data/*` に proxy する。 個人ログ系は `503 local_only`。
- モードは「ログの下のスイッチャ」 で排他的に切り替える (Local か、 Hub 1 つ)。

## 2. ローカル側 — モード制御 (`/api/multi/*`)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/multi/mode` | — | `{ mode: 'local'\|'multi', hubUrl: string\|null }` |
| POST | `/api/multi/mode` | `{ mode, url? }` | `{ ok, mode, hubUrl }` / `{ ok:false, needs_login:true, url }` |
| GET | `/api/multi/session?url=` | — | `{ connected: boolean, user? }` |
| POST | `/api/multi/login` | `{ url, email, password, label? }` | `{ ok, url, user }` |
| POST | `/api/multi/logout` | `{ url }` | `{ ok }` |

- `POST /api/multi/mode` で `multi` に切り替える際、 対象 Hub に未ログインなら
  モードは変えず `needs_login` を返す (frontend がログインフォームへ誘導)。
- `POST /api/multi/login` は Hub の `/api/auth/login` に email/password を渡す
  (ローカルは Cernere を一切知らない)。 返ってきた session token を per-hub に保存。
- `POST /api/multi/logout` は Hub の `/api/auth/logout` を叩き、 ローカルの
  session を破棄。 そのモードに居た場合は Local に戻す。

### サーバ登録管理

| method | path | req | res |
|---|---|---|---|
| GET | `/api/multi/status` | — | 登録済 Hub 一覧 + ログイン状態 |
| POST | `/api/multi/servers` | `{ url, label? }` | `{ ok }` |
| DELETE | `/api/multi/servers` | `{ url }` | `{ ok }` |

## 3. ローカル側 — proxy 層 (middleware)

Multi モード時、 `server/local/multi-proxy.ts` の middleware が feature router
より前段で横取りする:

- **Multi 対応 7 型の CRUD パス** → Hub の `/api/data/<type>` に転送。
  - `/api/bookmarks*` → `bookmarks`、 `/api/dig*` → `digs`、
    `/api/dictionary*` → `dictionary`、 `/api/implementation-notes*` →
    `implementation-notes`、 `/api/work-locations*` → `work-locations`、
    `/api/domains*` → `domain-catalog`、 `/api/notes*` → `notes`
- **個人ログ系のパス** (`diary` / `meals` / `locations` / `tracks` / `visits` /
  `trends` / `activity` / `weather` / `transit` / `review` 等) → `503 { error: 'local_only' }`
- **制御系・インフラ系** (`/api/multi/*` / `/api/setup/*` / その他) → 素通し
- Hub への Bearer は per-hub に保存した session token を直接使う (Cernere 非経由)。

## 4. Hub 側 (`server/multi/`)

| method | path | 認証 | 説明 |
|---|---|---|---|
| GET | `/` | — | Infisical 未設定→設定フォーム / 設定済→ログイン UI (HTML) |
| GET | `/api/setup/infisical/status` | — | `{ configured, ... }` |
| POST | `/api/setup/infisical` | — | machine identity を受け取り Infisical 接続 → Hub DB に永続化 |
| POST | `/api/auth/login` | — | `{ email, password }` → Cernere 代理ログイン → `{ sessionToken, user }` |
| GET | `/api/auth/me` | session | `{ userId, displayName, role }` |
| POST | `/api/auth/logout` | session | ステートレス (`{ ok }` のみ) |
| GET | `/api/data/:type` | session | 7 型の list (query: `limit` / `offset` / `q`) |
| GET | `/api/data/:type/:id` | session | 1 件取得 |
| POST | `/api/data/:type` | session | 作成 |
| PATCH | `/api/data/:type/:id` | session | 更新 (owner / admin / moderator のみ) |
| DELETE | `/api/data/:type/:id` | session | 削除 (owner / admin / moderator のみ) |

`:type` = `bookmarks | digs | dictionary | implementation-notes | work-locations | domain-catalog | notes`。

- session token は Cernere の project-token (PASETO v4)。 取得失敗時は Cernere
  accessToken (HS256) に degrade。 どちらも Hub の `authMiddleware` が検証できる。
- Hub は自分の Infisical project から `CERNERE_BASE_URL` 等を取得し、 自分が
  属する Cernere に代理ログインする。 拠点ごとに別 Cernere でよい。

## 5. 旧経路 (移行期間中・ Phase 6 で撤去予定)

以下は旧 OAuth-dance / share-relay 方式の名残。 二層設計では使われず、
既存接続が即死しないために残してあるだけ。 frontend の旧 Multi browse タブと
共に Phase 6 で撤去する。

| method | path | 備考 |
|---|---|---|
| POST | `/api/multi/active` | 旧 multi-select (複数 Hub 同時 active)。 二層では排他なので不要 |
| POST | `/api/multi/disconnect` | → `/api/multi/logout` に置換済 |
| GET/POST | `/api/multi/proxy/*` | → proxy 層 (middleware) に置換済 |
| POST | `/api/multi/share` | → Multi モードの通常 CRUD に置換済 |
| POST | `/api/multi/download` | → Multi モードの通常 CRUD に置換済 |
| GET/POST/DELETE | Hub `/api/shared/*` | → Hub `/api/data/*` に置換済 |

撤去時に `server/lib/cernere-session.ts` (ローカル直 Cernere 経路) も不要になる。
