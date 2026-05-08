# push — Web Push API

| method | path | req | res |
|---|---|---|---|
| GET | `/api/push/vapid-public-key` | — | `{ key: string }` |
| POST | `/api/push/subscribe` | `PushSubscribeRequest` | `{ id }` |
| GET | `/api/push/subscriptions` | — | `{ items: PushSubscriptionRow[] }` |
| DELETE | `/api/push/subscriptions/:id` | — | `{ ok }` |
| POST | `/api/push/test` | `{ title?, body? }` | `{ result }` |
