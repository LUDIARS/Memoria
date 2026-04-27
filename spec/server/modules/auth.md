# Module: Auth

`local` / `online` 切替、JWT 検証、admission revoke 連動。

## 目的
- ローカル開発では認証ゼロでサクサク動く
- オンライン共有運用では Cernere 認証フローと連動した HS256 JWT を要求

## ファイル
`service/auth.js`

## モード

| モード | 認証 | userId |
|-------|------|--------|
| `local` (既定) | なし | `null` (全データを単一テナント扱い) |
| `online` | `Authorization: Bearer <JWT>` 必須 | JWT.sub |

`MEMORIA_MODE=online` のときに `MEMORIA_JWT_SECRET` 不在ならプロセスを fatal exit する。

## JWT 仕様

- アルゴリズム: HS256
- 検証鍵: `MEMORIA_JWT_SECRET` (Cernere の `SERVICE_JWT_SECRET` と同期推奨)
- 有効期限: `exp` 必須 (秒, 過去なら 401)
- claim: `sub` (= user_id), `iat`, `iss` (任意)

## Hono middleware (`authMiddleware`)

```
local モード: c.set('userId', null), next()
online モード:
  - Authorization 不在 → 401 'bearer token required'
  - JWT 検証失敗      → 401 'unauthorized: <reason>'
  - sub 不在          → 401 'unauthorized: token missing sub'
  - OK                → c.set('userId', sub), next()
```

## 続いて admission revoke check (`index.js`)

`cernere.js` の `isAdmissionRevoked(userId)` を全 `/api/*` で確認、revoke 済なら 401。SDK 未ロード環境では常に false (admission 機能なし)。

## 開発用 token 発行

`service/scripts/issue-token.mjs`:

```bash
cd service
npm run issue-token <user_id> [--exp <seconds>]
```

`MEMORIA_JWT_SECRET` 必須、デフォルト 24h。

## Cernere 統合との関係

- Cernere の `CernereServiceAdapter` は `service_token` (HS256 JWT) を発行する。これは Memoria 側の middleware でそのまま検証可能 (両者が同じ secret を共有する前提)。
- Memoria は Cernere からの WS push (`onUserAdmission`) で revoke 状態を memoria プロセス内に保持し、`isAdmissionRevoked` で参照する。

## 環境変数

| 変数 | 用途 |
|------|------|
| `MEMORIA_MODE` | `local` / `online` |
| `MEMORIA_JWT_SECRET` | online モード必須。HS256 検証鍵 |
| `MEMORIA_TOKEN_EXP_SEC` | service_token 発行時の有効期間 (既定 900 = 15 分) |

## ロードマップ

- RS256 (Cernere project token) のサポート (現在 HS256 のみ)
- `WWW-Authenticate` ヘッダー付き 401 応答 (RFC 6750 準拠)
- 拡張機能から popup ベースで自動ログイン
