# Discord Bot (行動ログ入力 + 自動処理 + 通知)

Memoria server に discord.js Gateway Bot を同梱し、Discord を **行動ログの取得源** /
**自動処理の入力チャネル** / **通知の出力先** として使う。

## 方針 / 前提 (2026-05-30 決定)

- **個人サーバー想定。** サーバーに複数人いる場合は `features.discord.self_user_id`
  に **自分の Discord user id** を設定し、その人物のイベントのみログ対象にする
  (未設定なら全員ではなく「Bot 以外の人間全員」ではなく self 必須 = 取りこぼし
  防止のため、self 未設定時は capture を停止し UI で促す)。
- **送信は discord.js 直送** (同一 client を再利用)。将来 Nuntius 経由に切替可能な
  よう `notifier.ts` で薄く抽象化のみしておく。
- **Bot は「入力アダプタ」に徹する。** 6 つの自動処理は Memoria の既存パイプライン
  (task+reminder / meal_vision / visit+domain bookmark / recommendations-ai /
  通知トリガー) に委譲する。Bot 側で業務ロジックを再実装しない。
- **アクティビティ chnl は 1 本に集約** (`#activity`)。
- **AI 処理は Imperativus 風** だが、実行可能アクションを 6 種に制限したホワイト
  リストで縛る (任意コマンド実行はしない)。

## 個人データ境界 (RULE §5)

- 行動ログ (message / presence / voice / reaction) は **Memoria local に保存** (ローカル
  ログサービスの本分)。
- 氏名・メール・ロール等の **識別情報は Cernere が正本**。Discord user id を join key
  にし、識別情報をミラーしない。`self_user_id` と Cernere user の対応のみ持つ。
- Bot token は **Memoria の設定 UI から指定** し `app_settings`
  (`features.discord.bot_token`) に保存する。Memoria はローカル SQLite に閉じる個人
  アプリで OpenAI key 等も設定保存しているため同パターン。env
  `MEMORIA_DISCORD_BOT_TOKEN` をフォールバックで見る。値は GET API / フロント /
  ログには出さない (`token_set` の bool のみ公開)。

## 取得できる個人情報 (intent 別)

| 情報 | intent | 保存 kind |
|------|--------|-----------|
| メッセージ本文 / 添付 / 編集 | MESSAGE_CONTENT (privileged) | `discord_message` |
| リアクション | GUILD_MESSAGE_REACTIONS | `discord_reaction` |
| オンライン状態 / 端末 / アクティビティ(ゲーム/Spotify/カスタム) | PRESENCE (privileged) | `discord_presence` |
| ボイス入退室 / mute / 配信 / カメラ | GUILD_VOICE_STATES | `discord_voice` |
| ニックネーム / ロール / 参加日時 | GUILD_MEMBERS (privileged) | (識別情報は保存せず id のみ) |
| メール / 電話 / 連携アカウント | — | **Bot では取得不可** (範囲外) |

## Bot 権限 / OAuth

- OAuth2 scope: `bot`, `applications.commands`
- Privileged Gateway Intents (Dev Portal で ON 必須): MESSAGE CONTENT / SERVER MEMBERS / PRESENCE
- Permissions: View Channels, Read Message History, Send Messages, Embed Links,
  Attach Files, Add Reactions, **Manage Channels** (自動生成), Use Application Commands
- Manage Channels は強権限。自動生成は **Memoria カテゴリ配下のみ**、既存は触らない。

## チャンネル / カテゴリ自動生成

有効化時に冪等生成し、id を `app_settings` (`discord.channel.<kind>_id` /
`discord.category_id`) に保存。Concordia の `ensureDiscordLayout` と同方針。

- カテゴリ `Memoria`
  - `#activity` (集約: presence/voice/message ログのミラー & デバッグ)
  - `#task` `#memo` `#bookmark` `#meal` `#recommend` `#announce`
- オプトアウトされた機能のチャンネルは作らない。

## 6 つの自動処理 → 既存パイプライン

| 投稿 | トリガー | 委譲先 |
|------|---------|--------|
| タスク (リマインダー付) | テキスト or `/task` | `insertTask` + `features.tasks.reminder.*` |
| メモ (リマインダーなし) | テキスト or `/memo` | task(note) reminder 無し |
| ブックマーク | URL 検知 | visit + domain-catalog + (opt) bookmark 要約 |
| 食事 | 画像添付検知 | meal pipeline (`meals_auto_vision`) |
| おすすめ | `/recommend` slash | `recommendations-ai` → 結果投稿 |
| アナウンス | 既存通知トリガー | `notifier` → `#announce` 投稿 + 必要なら self メンション |

## AI ルーター (Imperativus 風 / 制限付き)

`#task/#memo/#bookmark/#meal` 以外への投稿、または曖昧な投稿は AI で意図分類し
6 アクションのいずれかにルーティング。実行は上記委譲先のみ。任意 shell/コード実行
はしない。AI 失敗時は `#activity` にログだけ残す。

## 設定 (`features.discord.*`、独立セクション)

すべて opt-out 可。`enabled` がマスタ。OFF の機能は capture もチャンネル生成もしない。

| key | 既定 | 意味 |
|-----|------|------|
| `features.discord.enabled` | false | マスタ (明示 opt-in) |
| `features.discord.self_user_id` | "" | ログ対象の自分の Discord user id |
| `features.discord.guild_id` | "" | 対象サーバー id |
| `features.discord.capture.message` | true | メッセージ取得 |
| `features.discord.capture.presence` | true | プレゼンス取得 |
| `features.discord.capture.voice` | true | ボイス取得 |
| `features.discord.capture.reaction` | true | リアクション取得 |
| `features.discord.ai_process` | true | AI ルーティング |
| `features.discord.mention_notify` | true | self メンション通知 |
| `features.discord.announce` | true | 通知の #announce 転送 |
| `features.discord.autoproc.task` / `.memo` / `.bookmark` / `.meal` / `.recommend` | true | 各自動処理 |
| `features.discord.bot_token` | "" | Bot token (設定 UI で指定 / 値は非公開、 env フォールバック可) |

## モジュール構成 (`server/discord/`、責務別)

- `client.ts` — discord.js client 生成 / login / ライフサイクル
- `intents.ts` — intent / partials 定義
- `settings.ts` — `discordSettings(db)` (privacy.ts 風) + token 取得
- `layout.ts` — カテゴリ/チャンネル冪等生成 + id 永続化
- `user-map.ts` — self_user_id 判定 / Discord↔Memoria
- `activity-capture.ts` — presence/voice/message/reaction → activity_events
- `message-router.ts` — 構造判定 (URL/画像/コマンド) + AI 分類 → action 振り分け
- `actions/{task,memo,bookmark,meal,recommend,announce}.ts` — 既存パイプライン委譲
- `slash-commands.ts` — `/task /memo /recommend` 等の登録 / ハンドラ
- `notifier.ts` — 送信抽象 (直送、将来 Nuntius 差替点)
- `index.ts` — bootstrap から呼ぶ起動/停止 (enabled 時のみ)

## activity_events 拡張

`ActivityKind` に `discord_message` `discord_presence` `discord_voice`
`discord_reaction` を追加 (db/types/activity.ts)。`/api/activity/event` の
ALLOWED_KINDS / `/api/activity/events` の allowedKinds にも追加。

## フェーズ

P1 基盤(client/intents/settings/privacy keys/bootstrap) → P2 layout/user-map →
P3 capture(activity_events) → P4 message-router + actions(task/memo/bookmark/meal) →
P5 slash(recommend) + mention/announce(notifier) → P6 設定UI「Discord」+ opt-out。
