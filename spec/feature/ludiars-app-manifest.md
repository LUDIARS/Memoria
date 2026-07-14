# LUDIARS App Manifest フォーマット

Memoria Hub Shell に集約されるアプリが Hub に対して公開する manifest の
形式。 schema 正本は [`../schema/ludiars-app-manifest.schema.json`](../interface/schema/ludiars-app-manifest.schema.json)、
shell 全体の設計は [`hub-shell.md`](./hub-shell.md) を参照。

- **公開経路**: `GET https://<app>/.well-known/ludiars-app.json`
  (CORS で Hub origin 許可、 HTTPS 必須。 詳細は [`hub-shell.md`](./hub-shell.md) §9.1)
- **配信形式**: `Content-Type: application/json; charset=utf-8`
- **キャッシュ**: `Cache-Control: max-age=300` 程度推奨 (Hub は ETag 尊重)

## フィールド一覧

| field | 必須 | 型 / 制約 | 用途 |
|---|---|---|---|
| `id` | ✅ | `^[a-z][a-z0-9-]{1,31}$` | URL / 内部キー (manifest 間で一意) |
| `displayName` | ✅ | string 1–64 | タブのアプリ名 |
| `description` | ✅ | string 1–40 | **タブの役割行** (例 「ナレッジ管理」) |
| `shortCode` | — | `^[A-Z][a-zA-Z]?$` | LUDIARS 2 文字略称 (Mm / A / Bb 等) |
| `icon` | — | string | emoji 1 字 or SVG/PNG URL |
| `version` | — | string | manifest 自体のバージョン (semver 推奨) |
| `entry` | ✅ | object (3 種から 1 つ) | mount 方式 (§entry) |
| `capabilities` | — | enum array | shell に要求する権限 |
| `dataChannels` | — | object array | アプリ間データ連携 (§dataChannels) |
| `routes` | — | object array | shell URL 空間でのパス (`/apps/<id>...`) |

## `entry` — 3 種の mount 方式 (oneOf)

```jsonc
// (a) Web Components
"entry": {
  "type": "web-component",
  "tag": "bibliotheca-app",                 // 必ずハイフンを含む
  "url": "https://app.example/element.js"
}

// (b) ESM module
"entry": {
  "type": "esm",
  "url": "https://app.example/mount.js"     // default export: { mount(el, ctx), unmount(el) }
}

// (c) Module Federation
"entry": {
  "type": "module-federation",
  "remoteEntry": "https://app.example/remoteEntry.js",
  "exposedModule": "./AppRoot"
}
```

最終的にどの方式を採用するかは [`hub-shell.md`](./hub-shell.md) §3 Decision-1
で確定する (Phase 0 では 3 方式とも schema に乗せておく)。

## `capabilities` — shell が提供する権限 (enum)

| 値 | 内容 |
|---|---|
| `cernere-session` | shell から Cernere session を受け取る |
| `design-tokens` | shell の CSS variable / Foundation UI トークンを継承 |
| `shell-router` | shell の history API にフックする |
| `push-notification` | shell 経由で WebPush を送る |

Phase 1 で各 capability の contract (mount context の型) を定義する。

## `dataChannels` — アプリ間連携 (Phase 0 は `task` のみ)

```jsonc
"dataChannels": [
  { "name": "task", "role": "provider" }    // 権威ストア (例: Actio)
  // role: provider | consumer | both
]
```

- `provider`: この channel の権威ストアを提供する
- `consumer`: 他 provider のデータを読む / 書く (自身では権威を持たない)
- `both`: 双方向同期する自前ストアを持ちつつ他 provider にも書く

詳細と task channel の interop 契約は [`hub-shell.md`](./hub-shell.md) §8。

## `routes` — shell URL マッピング

```jsonc
"routes": [
  { "path": "/apps/bibliotheca", "default": true }  // path は ^/apps/<id> 必須
]
```

複数 route を持てる (= deep link の suffix を寄せる)。 `default: true` の route が
`/apps/<id>` 単独でアクセスされた時の解決先。

## 最小例

```json
{
  "id": "memoria",
  "displayName": "Memoria",
  "description": "ナレッジ管理",
  "icon": "📓",
  "entry": {
    "type": "web-component",
    "tag": "memoria-app",
    "url": "https://memoria.example/dist/element.js"
  },
  "dataChannels": [{ "name": "task", "role": "consumer" }],
  "routes": [{ "path": "/apps/memoria", "default": true }]
}
```

同形のファイル: [`../../server/multi/shell/well-known.example.json`](../../server/multi/shell/well-known.example.json)

## Hub 側の使い方 (セットアップ UI フロー)

1. admin が `/admin/apps` で URL を貼付 (origin または manifest URL)
2. Hub backend が `<origin>/.well-known/ludiars-app.json` を fetch
   (SSRF 対策込、 詳細は [`hub-shell.md`](./hub-shell.md) §9.4)
3. JSON Schema で検証 → プレビュー (タブ外観 + capabilities + dataChannels) を表示
4. 確定 → `hub_apps` テーブルに保存
   ([`../../server/multi/shell/registry.schema.sql`](../../server/multi/shell/registry.schema.sql))
5. ライブ反映 — タブが増える

## バージョン管理 / 後方互換

- `version` フィールド (semver) はアプリ側 manifest の改訂版数 (Hub の解釈は
  「変わったら refetch しても古い state を上書きしてよい」 の目印)
- schema 自体の互換性は `$id` の URL バージョンで管理する。 破壊的変更時は
  `$id` の path を `v2/` に切る (Phase 1 以降に成立予定)

## 検証ツール (将来)

Hub の `/api/admin/apps/preview` は登録前にこの schema で検証する。 アプリ開発者は
ローカルで `ajv validate -s ludiars-app-manifest.schema.json -d my-manifest.json` の
ような ajv-cli ベース手順を踏める。 Phase 1 で `scripts/validate-manifest.mjs` を
同梱予定。
