# LINE 連携 (Concordia 経由)

LINE の公式アカウントは Concordia (Cc) が 1 つで受け、サービスごとの設定で振り分ける (neco 決定 2026-10-18)。
Memoria は Cc から **Memoria 宛てと決まったイベントだけ** を受け取り、返信の中身だけを返す。
LINE の署名検証・reply API の呼び出し・チャネルの秘密値は Cc が持ち、Memoria は持たない。

既存の LINE 送信 (帰宅・出発通知の push、`server/line/`) とは別の経路。

- 実装: `server/line-relay/` (中継トークン・紐付け・確認待ち・会話)、`server/routes/line-relay.ts`、設定画面 `server/public/src/line-relay-view.ts`
- 共有レベル: 🏠 local-only (タスク・日記は既存の正本に書く。LINE 側へ出るのは返信の文面だけ)
- Actio タスク: `actio:2ec65739-84d6-431a-8a2c-d453fcb9ea66`

## Cc / Mf / Memoria で共通の取り決め

- Cc → サービスの本文は LINE の webhook 本文と同じ形 (`{"destination","events":[...]}`) で、そのサービスに回すイベントだけを入れる。
  Cc は 1 本文 = 1 トークに分けて送る。追加ヘッダ `X-Concordia-Line-Channel: <チャネル名>` (Memoria は使わない)。
- 振り分けは Cc が行い、サービスはしない (グループ内のメンション判定もしない)。
  - text: 先頭の空白とボットへのメンションを除いた本文が、呼びかけの言葉で始まればそのサービスだけ。言葉が無ければトークの「ふだんの相手」だけ。
  - 「つなぐ <コード>」: 全サービスへ回す。`linked: true` を返したサービスを Cc がそのトークにつないだと記録する。
  - postback: Cc は返信内の postback data を `cc:<サービス名>:<元の data>` に包んで送り、押されたら外してそのサービスへ回す。
  - leave / memberLeft / memberJoined: つながっている全サービスへ。follow / join: 全サービスへ (返信は Cc が合流)。
- サービス → Cc の応答: `{"replies":[{"replyToken","messages":[...]}], "linked"?: true, "unlinked"?: true}`。
- ログ・画面に秘密値・本文・replyToken を出さない。例・テストは架空の値だけ。

## HTTP

### `POST /api/integrations/line/webhook` (Cc だけが呼ぶ)

Memoria の公開経路の作法 (Alexa の `/api/alexa/skill` と同じく `/api/` 配下、管理 scope ではなく個別の認証) に合わせた場所。

| 条件 | 応答 |
|---|---|
| 中継トークン未発行 | 503 `{"error":"integration_not_configured"}` |
| `Authorization: Bearer <中継トークン>` が欠落・不一致 | 401 `{"error":"relay_token_rejected"}` |
| 本文が JSON でない / `events` 配列が無い / 256KB 超 | 400 `{"error":"bad_request"}` |
| 処理中の失敗 | 500 `{"error":"line_relay_failed"}` |
| 成功 | 200 `{"replies":[...], "linked"?: true, "unlinked"?: true}` |

- 照合は保存済み SHA-256 ハッシュとの定数時間比較。
- 返信は届いたイベントの replyToken にだけ付け、1 つの replyToken に 5 件まで。返事の無いイベントは載せない。
- LINE の reply API は呼ばない。

### 設定画面用 (admin scope、`/api/line/*` と同じ守り)

| メソッド・パス | 内容 |
|---|---|
| `GET /api/line/relay` | `{"token_set": bool, "linked_talks": number}` |
| `POST /api/line/relay/token` | 中継トークンの発行 / 発行し直し。平文 `token` はこの応答で 1 度だけ返し、ハッシュだけ保存する |
| `DELETE /api/line/relay/token` | 中継トークンの消去 (以後 webhook は 503) |
| `POST /api/line/relay/link-code` | 「つなぐ」用の 6 桁コード `{"code","expires_at"}`。10 分有効・1 回だけ使える。出し直すと前の未使用コードは消える |

設定画面: 「🏠 帰宅・出発 / LINE」タブの「LINE 連携 (Concordia 経由)」節。

## 会話

トークは `user:<userId>` / `group:<groupId>` / `room:<roomId>` で表す。
紐付けたトークの発言は、紐付けを作った Memoria の利用者の操作として扱う (家族グループでも同じ。権限の細かい分けはしない)。

| 発言・イベント | 返事 |
|---|---|
| 「つなぐ <6 桁>」(全角・半角の空白と数字を許す) | Memoria のコードで期限内・未使用ならトークを紐付けて `linked: true`。期限切れ・使用済みは案内。Memoria の知らないコードは他サービス宛てなので返事をしない |
| 紐付いていないトークの発言・ボタン | 「つなぐ」の案内 |
| 「タスク ○○」 | 確認ボタン (はい / やめる)。「はい」で既存のタスク登録 (`registerTask`、Actio 正本) に 1 件足す |
| 「きょうのタスク」 | 今日締切・期限切れの未完了タスク (`selectTasks` の `due_today_or_overdue`) を期限の近い順に最大 10 件 |
| 「にっき ○○」 | 確認ボタン。「はい」で今日の日記メモ (`diary_entries.notes`) の末尾に `HH:MM 本文` を追記 (上書きしない) |
| それ以外・言葉なし (Memoria がふだんの相手のとき) | 使い方 |
| follow / join | 挨拶 (紐付け済みなら使い方、未紐付けなら「つなぐ」の案内) |
| leave | トークの紐付けと確認待ちを消して `unlinked: true` |
| memberLeft / memberJoined | 返事なし |

呼びかけの言葉は Cc で設定する (既定「タスク」「きょうのタスク」「にっき」)。
確認ボタンの postback data は `mm:yes:<確認待ち ID>` / `mm:no:<ID>`。確認待ちは 30 分有効で、押されたら 1 回で消える (二重に足さない)。
タスクは 200 文字、日記は 1000 文字まで。

## データ

| 置き場所 | 内容 |
|---|---|
| `app_settings['features.line_relay.token_hash']` | 中継トークンの SHA-256 (平文は持たない) |
| `line_relay_links (talk PK, linked_at)` | 紐付けたトーク |
| `line_relay_link_codes (code PK, expires_at, used_at, created_at)` | 「つなぐ」用コード |
| `line_relay_pending (id PK, talk, action, text, expires_at)` | 確認ボタン待ち (`action` は `task` / `diary`) |

テーブルは `ensureLineRelaySchema` が冪等に作る (`CREATE TABLE IF NOT EXISTS`、既存ドメインと同じ作法)。
タスク・日記は既存の正本に書き、LINE 連携用の別データは持たない。
