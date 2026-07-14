# Amazon Echo / Alexa連携セットアップ

Memoriaの設定画面では「プライバシー / 表示」→「Amazon Echo / Alexa」→
「Amazon側の設定手順を開く」から、この設定の要点を確認できる。

## 1. Alexa Custom Skillを作る

Alexa Developer Consoleで日本語（日本）のCustom Skillを作成し、
[`config/alexa/interaction-model.ja-JP.json`](../../config/alexa/interaction-model.ja-JP.json) を
Interaction ModelのJSON Editorへ読み込む。

Custom endpointはインターネットからHTTPS/443で到達できる次のURLにする。

```text
https://<memoria-public-host>/api/alexa/skill
```

AlexaのCustom Web Service要件に従い、公開時は信頼されたCAの証明書を使う。

## 2. Proactive Eventsを有効にする

Skill manifestへ次を追加する。

```json
{
  "permissions": [
    { "name": "alexa::devices:all:notifications:write" }
  ],
  "events": {
    "publications": [
      { "eventName": "AMAZON.MessageAlert.Activated" }
    ],
    "subscriptions": [
      { "eventName": "SKILL_PROACTIVE_SUBSCRIPTION_CHANGED" }
    ],
    "endpoint": {
      "uri": "https://<memoria-public-host>/api/alexa/skill"
    }
  }
}
```

Alexaアプリのスキル通知設定でも通知を許可する。許可後に届く購読イベントから、Memoriaは送信対象の
Alexa user IDとリージョンendpointをローカル保存する。

## 3. Memoriaへ資格情報を設定する

`server/.env.secrets` またはInfisical/env-cliで設定する。値をGitへコミットしない。

```dotenv
MEMORIA_ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MEMORIA_ALEXA_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxxxxxxxxxxxxxx
MEMORIA_ALEXA_CLIENT_SECRET=...
MEMORIA_ALEXA_PROACTIVE_STAGE=development
```

開発中は `development` endpointを使う。Skill認定・公開後だけ `live` へ変更する。

## 4. 動作確認

1. Alexa Developer ConsoleのTestで「メモリアを開いて」を実行する。
2. 「買い物をタスクに追加」と話し、Memoriaのタスク一覧へ1件登録されることを確認する。
3. MemoriaでWeb Push対象の通知を発生させ、Echoへ新着通知が届くことを確認する。
4. 「メモリアを開いて」または「メモリアで通知を読んで」と話し、本文が読み上げられることを確認する。

Proactive Eventsは自由文の即時アナウンスではない。EchoへはAmazon定型の新着通知が届き、
通知本文はスキル起動時に読み上げられる。
