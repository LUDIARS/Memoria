# Memoria プラグインテンプレート

Memoria の「🧩 ユーザーアプリ」タブに接続するプラグインの雛形。

プラグイン**実体は Memoria 本体リポには置かない**。 別 git 管理の
プラグインホスト (サイドカー, 例 `MemoriaPlugin` リポ) 側にこのテンプレートを
コピーして実装する。 Memoria 本体に入るのは「タブ + 接続 API + このテンプレ」 まで。

## 接続の仕組み (おさらい)

```
Memoria (5180)
  ├─ 🧩 ユーザーアプリ タブ
  │     └─ GET /api/plugins → ホストの /manifest を取得し子として一覧表示
  │     └─ 選択した plugin.url を iframe で表示
  └─ POST /api/plugins/announce ← プラグインからの通知を #announce へ
        (x-plugin-token == plugins.api_token で認可)

プラグインホスト (別リポ, 例 5191)
  └─ /plugins/<id>/  UI + API   /manifest  一覧
```

接続設定 (ホスト URL / API トークン) は Memoria の「ユーザーアプリ」 タブの
⚙ 接続設定 で行う。 トークンはホスト側 `MEMORIA_PLUGIN_TOKEN` と一致させる。

## 作り方

1. ホストリポの `plugins/<your-id>/` に `plugin.ts` を作り、 `MemoriaPlugin` を
   default export する (`plugin.ts.template` 参照)。
2. Memoria の「ユーザーアプリ」 タブを開くと manifest 経由で子として現れる。

ホストは起動時に `plugins/` を動的 import で自動探索する (Concordia の library
scanner と同じディレクトリ走査)。 登録配列の編集は不要で、 フォルダを置くだけでよい
(`.` / `_` 始まりのフォルダは除外)。

## 契約 (host/types.ts)

| フィールド | 説明 |
|---|---|
| `id` | 一意 ID (URL パスに使う) |
| `name` / `icon` / `description` | タブの子リストの表示 |
| `routes(r, ctx)` | `/plugins/<id>` 配下に UI("/") と API を生やす |
| `jobs[]` | `intervalMs` ごとに `run(ctx)` を呼ぶ定期処理 |

`ctx`:
- `ctx.settings` … プラグイン専用ローカル設定 (secret も。 リポには出ない)
- `ctx.memoria.announce(text)` … Memoria #announce に通知
- `ctx.log(msg)` … ログ
- `ctx.basePath` … 自分の公開ベースパス
