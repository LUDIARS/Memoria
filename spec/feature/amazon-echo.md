# amazon-echo — Alexa双方向連携

## 概要

Memoriaの通知をAmazon Echoで受け取り、Echoへの音声指示からMemoriaへタスクを登録できるようにする。
連携はAmazon Alexa Custom Skillの公式APIだけを使用し、個人データと資格情報はローカル環境から外へ不要に送らない。

## ユースケース

- Memoriaのタスク・天気・RSS・処理完了通知をEchoで受け取る。
- 「メモリアを開いて」「通知を読んで」と話し、未読通知の本文を聞く。
- 「牛乳を買うをタスクに追加」と話し、MemoriaへTODOを登録する。

## 画面 / 入口

- Echo / Alexa Custom Skill: 呼び出し名「メモリア」
- Alexa webhook: `POST /api/alexa/skill`
- Interaction Model: `config/alexa/interaction-model.ja-JP.json`
- Alexa Developer ConsoleとAlexaアプリでの設定手順: `spec/setup/amazon-echo.md`

## データ

新規テーブルは作らず、ローカルSQLiteの `app_settings` に有限状態を保存する。

| key | 内容 |
|---|---|
| `features.alexa.notifications.pending` | 最大20件の未読通知JSON |
| `features.alexa.proactive.user_id` | 通知許可ユーザーのAlexa user ID |
| `features.alexa.proactive.api_endpoint` | AmazonのリージョンAPI endpoint |
| `features.alexa.proactive.enabled` | Proactive Events購読状態 |
| `features.alexa.proactive.updated_at` | 購読イベント順序判定timestamp |
| `features.alexa.processed_requests` | 最大50件のrequestId/taskId重複排除情報 |

LWA access tokenはプロセスメモリだけに保持する。

## API

- [`../interface/alexa.md`](../interface/alexa.md) — Alexa Skill webhook
- Amazon LWA token endpoint — client credentials、scope `alexa::proactive_events`
- Amazon Proactive Events API — `AMAZON.MessageAlert.Activated`

## シェア可能か

**local-only / 外部送信は明示opt-in**

タスクと通知本文はHubへ共有しない。AlexaアプリでSkill通知を許可し、envへ資格情報を設定した場合だけ、
Amazonへ未読件数と送信元名を送る。

## プライバシー観点

- タスク、通知タイトル、通知本文、Alexa user IDはローカルSQLiteだけに保存する。
- Amazonへ送信するProactive Eventには未読件数と送信元名だけを含める。
- LWA client secret、access token、Alexa署名ヘッダーをログへ出さない。
- 購読解除イベントを受けたら、そのユーザーへの能動通知を停止する。

## 重要な制約

- Alexa Proactive Eventsは任意の文章を即時読み上げるAPIではない。Echoへは
  `AMAZON.MessageAlert.Activated` の定型通知を送り、通知タイトル・本文はMemoriaのローカルDBに保持する。
- ユーザーがMemoriaスキルを起動するか「通知を読んで」と指示したとき、未読通知の本文をEchoが読み上げる。
- Proactive EventsはAlexaアプリで通知を許可したユーザーだけに送る。
- AlexaからMemoriaへ届くHTTPSリクエストはAmazon ASK SDKで署名とtimestampを検証する。

## 要件

### MemoriaからEchoへの通知

1. Web Pushへ送っているMemoriaのアプリ通知をAlexa通知キューにも積む。
2. キューは最大20件とし、古い項目から破棄してローカルDBの無制限増加を防ぐ。
3. Alexa通知が許可され、LWA資格情報が設定されている場合はProactive Events APIへ通知する。
4. LWA access tokenは有効期限内だけメモリにキャッシュし、DBやログへ保存しない。
5. 通知のタイトル・本文はAmazon Proactive Events APIへ送らず、件数と送信元名 `Memoria` だけを送る。
6. スキルが読み上げた項目だけを未読キューから削除する。

### EchoからMemoriaへのタスク登録

1. `CreateTaskIntent` の `TaskTitle` をタスク名として登録する。
2. 空文字と200文字を超えるタスク名は拒否し、Alexaへ再入力を促す。
3. Alexa利用者が音声で作るため `creator_type = human`、`kind = task`、`status = todo` とする。
4. 通常のタスクAPIと同じ日記追記・activity event記録を行う。
5. Alexaの `requestId` を直近50件保存し、同じリクエストの再送でタスクを重複登録しない。

## モジュール境界

| モジュール | 責任 |
|---|---|
| `server/alexa/config.ts` | envの検証とAlexa API endpoint制限 |
| `server/alexa/store.ts` | 未読通知・購読状態・重複排除状態のローカル保存 |
| `server/alexa/proactive-events.ts` | LWA token取得とProactive Events送信 |
| `server/alexa/skill.ts` | Alexa request envelopeの解釈とresponse生成 |
| `server/alexa/verifier.ts` | ASK SDKによる署名・timestamp検証 |
| `server/routes/alexa.ts` | HTTP body境界、application ID照合、エラー応答 |
| `server/shared/task-registration.ts` | APIとAlexaが共有するタスク作成副作用 |
| `server/notifications.ts` | Web PushとAlexaへの通知fan-out |

## 設定

機能は `MEMORIA_ALEXA_SKILL_ID` が設定されたときだけ受信可能になる。能動通知にはさらに
`MEMORIA_ALEXA_CLIENT_ID` と `MEMORIA_ALEXA_CLIENT_SECRET` が必要。

| env | 必須 | 用途 |
|---|---|---|
| `MEMORIA_ALEXA_SKILL_ID` | 受信時 | request envelopeのapplication ID照合 |
| `MEMORIA_ALEXA_CLIENT_ID` | 送信時 | LWA client credentials |
| `MEMORIA_ALEXA_CLIENT_SECRET` | 送信時 | LWA client credentials |
| `MEMORIA_ALEXA_PROACTIVE_STAGE` | 任意 | `development`（既定）または `live` |

資格情報が不足している場合、Alexa受信または能動通知は明示的に無効となる。別実装への暗黙fallbackは行わない。

## テスト方針

- 正常な `CreateTaskIntent` が1件だけタスクを作る。
- 同一 `requestId` の再送が既存タスクを返し、重複作成しない。
- 空・長すぎるタイトルを拒否する。
- Launch/ReadNotificationsが読み上げた通知だけをキューから削除する。
- 古い購読イベントが新しい購読状態を上書きしない。
- LWA/API失敗、未設定、未購読を送信結果として区別する。
- HTTP境界で本文サイズ、署名、timestamp、application IDを検証する。
