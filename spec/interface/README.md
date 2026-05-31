# `spec/api/` — HTTP API 契約

Memoria ローカルサーバの REST API を request / response 単位で documenta する。
`server/api/types/<domain>.ts` の TypeScript 型と一対一で対応。

## 構成

```
spec/api/
├── README.md            ← 全体方針 + endpoint 一覧
└── <domain>.md          ← endpoint 群を domain で束ねた spec
```

## 表記

- **path**: `/api/...` (Hono の同名)
- **method**: GET / POST / PATCH / DELETE
- **req**: request body の interface 名 (TS 型と一致)
- **res**: success response の interface 名
- **err**: 一般的なエラーレスポンス (`{ error: string }`)

## ルール

- **正本は spec**。 実装より先に spec を書く / 修正する。
- timestamp 系は **UTC ISO の string** で送受信し、 client 側は `parseUtcIso`
  経由でローカル変換 (PR #104 で導入済)。
- enum (status / kind 等) は string literal union を使い、 typo を tsc で弾く。
- **任意フィールド**は `?:`、 **null 許容**は `T | null` で明示的に区別する。

## エンドポイント (domain 別)

| Domain | spec | 主な endpoint |
|---|---|---|
| タスク | [task.md](task.md) | `/api/tasks*`, `/api/tasks/categories`, `/api/tasks/:id/agent-run` |
| AI 委託 | [agent.md](agent.md) | `/api/agent-projects*`, `/api/agent-runs*` |
| 作業場所 | [workplace.md](workplace.md) | `/api/work-locations*`, `/api/work-sessions`, `/api/work-locations/checkin`, `/api/work-locations/resolve-place` |
| ブックマーク | [bookmark.md](bookmark.md) | `/api/bookmark*`, `/api/bookmarks/from-url` |
| ドメイン辞書 | [domain.md](domain.md) | `/api/domains*`, `/api/domains/from-url` |
| 実装自慢 | [impl.md](impl.md) | `/api/implementation-notes*` |
| 辞書 | [dict.md](dict.md) | `/api/dictionary*`, `/api/stopwords*` |
| Dig | [dig.md](dig.md) | `/api/dig*`, `/api/wordcloud*` |
| 食事 | [meal.md](meal.md) | `/api/meals*` |
| 日記 | [diary.md](diary.md) | `/api/diary*`, `/api/weekly*` |
| GPS / アクセス | [visit.md](visit.md) | `/api/locations*`, `/api/visits*`, `/api/page-metadata*` |
| 設定 | [config.md](config.md) | `/api/privacy/settings`, `/api/llm/config`, `/api/setup-docs*`, `/api/tracks/settings` |
| マルチ | [multi.md](multi.md) | `/api/multi/*` |
| Push | [push.md](push.md) | `/api/push/*` |
| 傾向 / ログ | [misc.md](misc.md) | `/api/trends/*`, `/api/events`, `/api/uptime`, `/api/recommendations*` |
| ノート | [note.md](note.md) | `/api/notes*`, `/api/notes/from-chat` |
| 拡張ルール | [misc.md](misc.md) | `/api/extension/rules` (拡張 dispatch 設定) |
