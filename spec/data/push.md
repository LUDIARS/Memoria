# push — Web Push 購読

## `push_subscriptions`
ブラウザ / iOS PWA からの Web Push 購読を保持。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `endpoint` | TEXT | ✓ | — | UNIQUE。 Push Service 側のエンドポイント |
| `p256dh` | TEXT | ✓ | — | 暗号鍵 |
| `auth` | TEXT | ✓ | — | 認証鍵 |
| `label` | TEXT |  | NULL | 端末ラベル (任意) |
| `user_agent` | TEXT |  | NULL | 識別用 |
| `created_at` | TEXT | ✓ | UTC | |
| `revoked_at` | TEXT |  | NULL | UTC ISO。 NULL = active |

Index: `idx_push_subscriptions_active` (revoked_at IS NULL の WHERE 部分インデックス)

## VAPID 鍵
`<DATA>/vapid.json` に保存 (DB 外)。 初回起動で自動生成。
