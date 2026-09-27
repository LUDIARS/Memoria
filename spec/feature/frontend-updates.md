---
type: feature
title: Safe frontend update detection
service: memoria
status: implemented
---

# SPEC-MM-FRONTEND-UPDATES

Lw (Ludellus) のSW更新登録・ネットワーク優先方針を採用する。
登録は `updateViaCache: none`、起動時・画面復帰時・表示中の60秒周期で更新確認する。
既存のPush通知機能を維持し、HTML/JS/CSSとAPIはHTTPキャッシュを経由せず取得する。
Memoriaでは個人データを保存しないためCache Storageへの格納やオフライン応答の再利用はしない。

フロントエンドビルド時に配信物のハッシュ `app-version.json` を生成し、SW自体に変更がなくても
開いている画面で新版を検知する。通常ビルドとExcubitor起動前ビルドは同じ生成処理を使う。
SWの制御切替またはハッシュ変更で「更新があります」を表示する。入力を守るため自動再読込せず、
利用者が保存を確認してから再読込する。ページ離脱時に更新タイマーを解放する。
