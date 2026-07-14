# push-notification — PWA Web Push

## 概要
Memoria 内蔵の Web Push 配信 (web-push lib + VAPID 鍵)。 端末ごとの subscription を `push_subscriptions` で持ち、 タスクリマインダー / バッチ通知 / テスト送信を行う。 Actio と違って Nuntius プロキシは経由せず直接配信 (memory `feedback_pwa_webpush_pattern.md`)。

## ユースケース
- 朝 6:00 に未完了タスクをまとめて通知 (`tasks_reminder_*` 設定 + scheduler)
- 日記 / Dig / ブクマ要約完了の即時 / batch 通知 (memory `feedback_memoria_push_triggers.md`)
- iOS PWA は homescreen 追加が必須

## 画面 / 入口
- 設定 → `通知` タブ: VAPID 公開鍵 / subscribe ボタン / 端末一覧 / テスト送信
- リマインダー時刻 / Nuntius 連携設定もここ

## データ
- [push_subscriptions](../data/push.md) — endpoint (UNIQUE) / p256dh / auth / label / user_agent / revoked_at
- VAPID 鍵: `<DATA>/vapid.json` (DB 外、 初回起動で自動生成)

## API
- [push.md](../interface/push.md) — `/api/push/vapid-public-key` / `/api/push/subscribe` / `/api/push/subscriptions` / `DELETE /api/push/subscriptions/:id` / `/api/push/test`

## シェア可能か
**local-only**

push subscription は端末固有の機微鍵 (p256dh / auth) を含むためシェア対象外。

## プライバシー観点
- **個人データを保持するテーブル**: `push_subscriptions` (subscription endpoint URL = ブラウザベンダの push service への ID、 端末識別性が高い)、 `vapid.json` (秘密鍵)。
- **LLM プロバイダに送る情報**: push 機能自体は LLM 非依存。 通知本文 (タイトル / body) は事前生成済の文字列を `webpush.sendNotification` で送るだけ。
- **共有時に外部に出ない情報**: 全部 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/push/subscriptions/:id` で行を**ハード削除**。 web-push 失敗時 (4xx) は `revoked_at` を立てて soft revoke する経路もある (`server/push.ts`)。 VAPID 鍵 (`vapid.json`) は手動削除 (削除すると全 subscription が再 subscribe 必要)。
