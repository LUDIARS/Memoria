---
name: memoria-worklog
description: Memoria に作業ログ、タスク、チャット抜粋、実装自慢を記録する。
---

# Memoria Worklog

ユーザーが Memoria への記録、タスク追加、チャット内容の保存、実装自慢の作成を依頼したときに使う。

## 接続先

`MEMORIA_URL` が設定されていればそれを使う。未設定なら `http://localhost:5180` を使う。

## 操作

- タスク: `POST /api/tasks` に `title`、任意の `details`、任意の `due_at`、任意の `share_actio` を送る。
- 外部チャット: `POST /api/external-chat/messages` に `source`、`content`、任意の `role`、任意の `conversation_id`、任意の `metadata` を送る。
- 実装自慢: `POST /api/implementation-notes` に `product`、`title`、`good_points`、`bad_points`、`shareable` を送る。

## ルール

- 記録は短く、事実ベースにする。
- 秘密情報、トークン、パスワード、個人情報は含めない。
- ユーザーが明示していない限り、勝手に `shareable` や `share_actio` を有効にしない。
