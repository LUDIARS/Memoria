# notifications — 他サービスからの個人宛て通知

Actio などのサービスが、 個人タスクの通知を Memoria 経由で配るための入口。
配送は既存の WebPush (`push.md`) と Alexa 通知に任せる。 Memoria はシングルユーザー・loopback 前提で、 既存 `/api/*` と同じ信頼境界で受ける。

| method | path | req | res |
|---|---|---|---|
| POST | `/api/notifications` | `InboundNotification` | `202 { ok, push: PushSendResult, alexa: { status } }` / `400 { error }` |

## InboundNotification

| field | type | 必須 | 説明 |
|---|---|---|---|
| `title` | string (1–200) | ○ | 通知タイトル |
| `body` | string (≤ 2000) | | 本文 |
| `url` | string | | クリック先。 相対パス (`/` 始まり) か http(s) URL のみ。 省略時 `/` |
| `tag` | string (1–128) | | 端末側で同じ通知をまとめるタグ。 省略時は `source:event:task_id` |
| `source` | label | ○ | 送り元サービス (例 `actio`) |
| `event` | label | | イベント名 (例 `task.completed`) |
| `task_id` | label | | 送り元のタスク id |

label は 1–128 文字の英数と `.` `_` `:` `-`。

## 呼び出し元

- Actio `modules/task/notifications/memoria-sink.ts` (Actio `spec/feature/task-integration/spec.md` §2.5)。
