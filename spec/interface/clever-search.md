# Clever Search HTTP API

すべて same-machine 専用のローカル Memoria API。接続元アドレスがこの端末の
loopback または network interface で、URL host も loopback・端末 hostname・端末の
interface address・`server/browser-host-config.ts` の明示 allowlist のいずれかであり、
`Origin` がある場合は request URL と同一 origin でなければ `403` を返す。TLS 終端
proxy の origin 比較には `X-Forwarded-Proto` の `http` / `https` だけを反映する。
個人ログを含むため成功・失敗を問わずレスポンスは
`Cache-Control: no-store` とする。型の正本対応は
`server/api/types/clever-search.ts`。

## `POST /api/clever-search`

Request:

```json
{
  "query": "Memoria",
  "refresh": false
}
```

- `query`: 必須、空白正規化後1〜120文字
- `refresh`: 任意。`true` なら保存済みレポートを使わず再作成

Response `200`:

```json
{
  "reportId": 42,
  "cached": false,
  "retrievalElapsedMs": 28,
  "report": {
    "version": 1,
    "query": "Memoria",
    "normalizedQuery": "memoria",
    "totalHits": 120,
    "summary": "…",
    "firstOccurredAt": "2026-05-01 09:00:00",
    "lastOccurredAt": "2026-08-06 10:00:00",
    "categories": [],
    "timeline": [],
    "createdAt": "2026-08-06T03:00:00.000Z",
    "searchElapsedMs": 20
  }
}
```

`cached=true` の場合も同じ形式で、`reportId` は既存レポートを指す。

Errors:

- `400`: query 欠落・長すぎる query・不正な `refresh` / `limit` / report ID
- `403`: same-machine ではない接続、未信頼 host、または cross-origin request（全 endpoint 共通）
- `500`: FTS5 初期化や保存済み JSON の破損など、ローカル索引の契約違反

## `GET /api/clever-search/reports?limit=30`

保存済みレポートのメタデータを新しい順で返す。`limit` は1〜100。
省略時は20。10進の正整数以外、0、100超は `400` とし、引用本文を含む
レポート本体は返さない。

## `GET /api/clever-search/reports/:id`

保存済みレポート本体を返す。形式は `POST` の response と同じで
`cached=true`。存在しないIDは `404`、不正なIDは `400`。
