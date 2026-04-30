# モバイル共有 → Memoria

Memoria は Web Share Target として登録されるので、OS の共有シートから URL を
直接サーバへ渡して、Chrome 拡張で保存したときと同じようにキューに積めます。

仕組み:

1. `server/public/manifest.webmanifest` で `share_target.action = /share` を宣言。
2. ユーザーが Memoria を PWA としてインストールすると、ブラウザが
   `GET /share?url=…&title=…&text=…` を送る。
3. `server/index.js` の `app.get('/share')` が最初に見つかった http(s) URL を
   抽出し (`url` を優先、なければ `text` / `title` から正規表現で拾う)、
   `bulkSaveUrls([url])` を呼んで `/?share=ok&u=…` に 303 リダイレクトする。
4. SPA が保存完了のワンショットトーストを表示する。

## Android (Chrome / Edge / Brave)

1. Chrome で `https://<your-memoria-host>/` を開く。
2. メニュー → **ホーム画面に追加**（または **アプリをインストール**）。
3. インストール後、任意のアプリの共有シートに **Memoria** が出るようになる。
4. ページを共有すると URL が `/share` に渡される。サーバ側で HTML を取得して
   要約し、ブックマークキューに追加される。

## iOS (Safari)

iOS Safari は Web Share Target を**実装していない**ため、PWA を iOS 共有
シートに登録する手段がありません。回避策として iOS ショートカットを使います:

1. **ショートカット** アプリを開く。
2. **+** → **新規ショートカット** をタップ。
3. **入力から URL を取得** アクションを追加。
4. **URL** (`https://<your-memoria-host>/share?url=`) を追加。
5. **テキストを結合** で 4 のURLと 3 で取り出した URL（URL エンコード済み）を
   連結する。一番素直な手順は、間に **URL エンコード** アクションを挟んでから
   **URL の内容を取得** をメソッド `GET` で実行する。
6. ショートカット設定で **共有シートに表示** をオンにする。
7. **共有シートのタイプ** を **URL** に設定する。

`.shortcut` に相当する最小構成（ショートカットエディタに貼り付け可能なイメージ）:

```text
アクション 1: URL の内容を取得
  URL: https://YOUR-HOST/share?url=[URL エンコード済みショートカット入力]
  メソッド: GET
  ヘッダ: （なし）
```

保存しておくと、Safari で URL を共有 → Memoria を選ぶとショートカットが走り、
サーバがページを保存し、レスポンス (`/?share=ok…` へのリダイレクト) は
破棄される、という流れになります。

## ローカル限定 / 非公開デプロイ

Memoria が localhost からしか到達できない場合でも、PWA インストール自体は
デスクトップで動作します（Chrome → アプリをインストール）。ただしモバイルの
共有ターゲットは公開された HTTPS ホストが必須です。よくある構成:

- 個人用途なら Tailscale + 独自 DNS。
- `npm start` の前段にリバースプロキシ (Caddy / Cloudflare Tunnel) を置く。

`/share` ハンドラは到達できる相手を区別しないので、認証なしでインターネットに
公開しないでください。マルチサーバモード (issue #34) では `/share` と他の
API の前段に Cernere SSO を入れる予定です。
