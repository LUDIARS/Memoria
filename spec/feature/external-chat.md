# external-chat — chitchat 外部 chat 取り込み

## 概要
外部チャット (Discord / Slack / Gemini Web Research / 手動コピペ等) からの抜粋メッセージをログ。 source / conversation_id / role / content / metadata で 1 メッセージ 1 行。 主用途は Gemini Web Research の結果を作業ログに残すこと。

## ユースケース
- Gemini Web Research (LLM の検索) の結果を作業ログタブに残す (UI: `wlGeminiWebList`)
- 手動コピペで外部 chat の重要発言を記録
- 同じ `conversation_id` でスレッド束ね

## 画面 / 入口
- `📝 ログ` (worklog) タブ → Gemini Web Research セクション
- `POST /api/external-chat/messages` で他ツールから投稿 (Memoria CLI / hook 等)

## データ
- [external_chat_messages](../data/chat.md) — source / conversation_id / role / content / metadata_json / received_at

## API
- [task.md](../interface/task.md) (同じ router 内) — `POST /api/external-chat/messages` / `GET /api/external-chat/messages` (source / limit / offset で絞り込み)

## シェア可能か
**local-only**

外部 chat 抜粋は Hub にシェアできない。 機微チャネル名や個人発言が含まれる前提のためローカル限定。

## プライバシー観点
- **個人データを保持するテーブル**: `external_chat_messages` (会話本文。 metadata_json にチャネル名 / URL / 相手の表示名等が入る)。
- **LLM プロバイダに送る情報**: 機能自体は LLM 非依存。 ただし日記生成 / dig / wordcloud の prompt にこれらメッセージが含まれる経路は **無い** (現状 diary aggregator は external_chat を集計対象にしていない)。
- **共有時に外部に出ない情報**: 全部。
- **削除時の挙動**: 削除 API 無し (現状)。 SQL 直接削除のみ。 Gemini Web Research 投稿は `/api/activity/event` (kind=gemini_prompt) も同時に書く運用なので、 そちら側の row も別途処理必要。
