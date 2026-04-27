# Module: Auth

`local` / `online` 切替、JWT 検証、admission revoke 連動。

## 目的
- ローカル開発では認証ゼロでサクサク動く
- オンライン共有運用では Cernere 認証フローと連動した HS256 JWT を要求

## ファイル
`service/auth.js`

## モード

| モード | GET (read) | 書込 (PATCH/POST/DELETE) | userId |
|-------|------------|-------------------------|--------|
| `local` (既定) | 開放 | 開放 | `null` (単一テナント) |
| `online` | **公開 (auth 不要)** | Bearer JWT 必須 (`requireAuth(c)`) | JWT.sub |

`MEMORIA_MODE=online` のときに `MEMORIA_JWT_SECRET` 不在ならプロセスを fatal exit する (誤起動防止)。

## JWT 仕様

- アルゴリズム: HS256
- 検証鍵: `MEMORIA_JWT_SECRET` (Cernere の `SERVICE_JWT_SECRET` と同期推奨)
- 有効期限: `exp` 必須 (秒, 過去なら 401)
- claim: `sub` (= user_id), `iat`, `iss` (任意)

## Hono middleware (`authMiddleware`) — fail-open

```
local モード:
  c.set('userId', null), c.set('mode', 'local'), next()

online モード:
  - Authorization 不在  → userId=null で next() (= 読み取り専用扱い)
  - 不正 / 期限切れ JWT → userId=null で next()
  - 有効な JWT          → c.set('userId', sub), next()
```

middleware 自体は **拒否しない** ところがポイント。read endpoint は誰でも呼べる必要があるため、認可は **書込ハンドラ内で `requireAuth(c)` を呼ぶ** 形にした。

## requireAuth(c) ヘルパー

```js
function requireAuth(c) {
  if ((c.get('mode') ?? 'local') !== 'online') return null;  // local では常に通す
  if (c.get('userId')) return null;                          // 認証済 OK
  return c.json({ error: 'unauthorized: sign-in required for write actions' }, 401);
}
```

書込ルート (`POST /api/bookmark` 等) の冒頭で `const denied = requireAuth(c); if (denied) return denied;` で 1 行ガード。

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
