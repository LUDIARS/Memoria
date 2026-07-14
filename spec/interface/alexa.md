# amazon-echo — Alexa Skill API

| method | path | request | response |
|---|---|---|---|
| POST | `/api/alexa/skill` | Alexa request envelope（raw JSON + Alexa署名ヘッダー） | Alexa response envelope |

## 受信ヘッダー

- `SignatureCertChainUrl`
- `Signature-256`
- `Content-Type: application/json`

本文は64 KiB以下でなければならない。署名・timestamp検証に失敗した場合は `400`、
`context.System.application.applicationId` が設定済みSkill IDと一致しない場合は `403` を返す。

## 対応request type

| request type / intent | 動作 |
|---|---|
| `LaunchRequest` | 未読通知を最大5件読み上げる。なければ使い方を案内する |
| `IntentRequest / CreateTaskIntent` | `TaskTitle` をタスクとして登録する |
| `IntentRequest / ReadNotificationsIntent` | 未読通知を最大5件読み上げる |
| `AMAZON.HelpIntent` | 使い方を案内する |
| `AMAZON.CancelIntent`, `AMAZON.StopIntent` | セッションを終了する |
| `AlexaSkillEvent.ProactiveSubscriptionChanged` | 通知購読状態とAlexa user IDを更新する |
| `SessionEndedRequest` | 空responseを返す |

## Alexa response

```json
{
  "version": "1.0",
  "response": {
    "outputSpeech": { "type": "PlainText", "text": "..." },
    "shouldEndSession": true
  }
}
```

SSMLは使用しない。タスク名と通知本文は読み上げ前に制御文字を除去し、応答全体を有限長にする。
