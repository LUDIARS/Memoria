---
task: home-presence-notify
project: Memoria
kind: 実装
created: 2026-10-13T00:00:00.000Z
---
# 帰宅・出発通知 (近く / 到着 / 出発) と LINE 送信

## 背景 (neco 指示 2026-10-13)

> Memoria に家の近くに来たよね通知と家出発したよね通知を実装する話が初期にあったんだけど結局やってないのでやりたい
> トリガーにして買い物などの通知を仕掛ける / LINE に投稿できるようにする
> 専用の通知として作り直す

設計: [spec/feature/home-presence-notify.md](../feature/home-presence-notify.md)

## 完了条件

- 自宅 (work_locations is_home=1、 無ければ天気の固定座標) を基準に、 近くに来た / 着いた / 出発した を判定する。 ヒステリシス・鮮度・cooldown 付き。
- event ごとの rule (一言 + タスク条件 + 送り先) を設定画面で追加・編集・削除・テスト送信できる。
- 送り先に Discord と LINE (Messaging API push) を選べる。 LINE のトークンは GET で返さない。
- Discord Bot が OFF でも LINE だけで動く。
- 旧 Discord 通知トリガーの `gps` 種別は rule へ移行し、 旧判定コードを削除する。
- zone 判定・event 生成・設定正規化・LINE 送信・移行に単体テストがある。
