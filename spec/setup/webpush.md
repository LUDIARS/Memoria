# WebPush 通知を有効にするための設定

## 目的

日記 / Dig / ブックマーク要約などの完了時に、 スマホ / ブラウザへ push 通知を
飛ばす。 Memoria 内蔵の WebPush 実装 (Nuntius とは独立したシングルユーザ向け /
`server/push.ts:1-9`)。

## 仕組み (= ほぼ自動)

VAPID 鍵は **env が無ければ起動時に自動生成** され `<dataDir>/vapid.json` に
永続化される。 つまり **既定では何も設定しなくても push は使える**
(`server/push.ts:45-65`)。 通知を受けるには端末側でブラウザの通知許可 +
(iOS は) PWA インストールが要る。

## 設定キー (任意の env)

VAPID 鍵を自分で固定したい (複数環境で共有 / 再生成で購読を失いたくない) ときだけ。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| VAPID 公開鍵 | `VAPID_PUBLIC_KEY` | (自動生成) | 両方揃うと env を使い、 無ければ `<dataDir>/vapid.json` → 自動生成 | `server/push.ts:46-48` |
| VAPID 秘密鍵 | `VAPID_PRIVATE_KEY` | (自動生成) | 同上 (公開鍵とペアで設定) | `server/push.ts:46-48` |
| VAPID subject | `VAPID_SUBJECT` | `mailto:noreply@memoria.local` | 連絡先 (mailto: / https:) | `server/push.ts:42` |

解決順: `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (両方) → `<dataDir>/vapid.json` →
新規生成して同ファイルに保存 (`server/push.ts:45-62`)。

subscription (端末) は `push_subscriptions` テーブルで管理。 配信時に 410/404 が
返った購読は `revokedAt` を立てて以降の送信対象から外す (`server/push.ts:1-9`)。

## 手順 (通常: 設定不要)

1. Memoria を起動 (VAPID 鍵が無ければ自動生成 → 起動ログに
   `[push] generated VAPID keys at ...`)。
2. `http://localhost:5180/` を開き、 設定 → 🔔 (通知) からブラウザの通知許可。
3. iOS は Safari の共有 → 「ホーム画面に追加」 でアプリ化してから起動しないと
   通知許可ダイアログが出ない (iOS 16.4+ /
   [`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md))。

VAPID 鍵を固定したい場合のみ:

```bash
# 任意のツールで VAPID 鍵ペアを生成 (例: web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com npm start
```

## 通知が飛ぶタイミング

push のトリガーは機能ごとに頻度が違う (運用メモ [[feedback_memoria_push_triggers]]):
日記 / Dig は **即時**、 ブックマーク要約は **5 件 or 5 分の batch**。 同一 tag の
連続 batch は上書きされる。 詳細は API spec [`../api/push.md`](../interface/push.md)。

## 注意点

- **VAPID 鍵を再生成すると既存購読が全部無効になる**。 env で鍵を渡さない場合は
  `<dataDir>/vapid.json` を消さないこと (`server/push.ts:4-8`)。
- **iOS は PWA インストールが必須**。 Safari タブのままでは通知許可が出ない。
- VAPID 未構成のまま `/api/push/vapid-public-key` を叩くと 503 が返る
  (`server/routes/push.ts:25-28`)。 通常は自動生成されるのでこの状態にはならない。
- 個人データはローカルに閉じる方針なので、 push の本文に外部送信したくない機微情報を
  載せない (通知本文はブラウザベンダの push サービスを経由する)。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `/api/push/vapid-public-key` が 503 | VAPID 未構成。 起動ログを確認、 通常は自動生成される |
| 通知が来ない (iOS) | PWA 未インストール。 「ホーム画面に追加」 してから許可 |
| 環境を変えたら購読が無効に | VAPID 鍵が変わった。 env で固定鍵を渡すか `vapid.json` を引き継ぐ |
| 一部端末だけ届かない | 410/404 で revoke 済の可能性。 端末側で再購読 |

## 関連

- [`README.md`](./README.md) — 設定の優先順位
- [`config-reference.md`](./config-reference.md) — 全キー一覧
- [`../api/push.md`](../interface/push.md) — WebPush API 仕様
- [`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md) — iOS PWA 通知の前提
