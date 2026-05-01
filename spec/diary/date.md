# `diary/date.js` — 日付ユーティリティ

## 目的

日記モジュールが共通で使う「ローカルタイムでの日付計算」 を集約する。
ISO UTC 文字列を直 slice すると JST と 9 時間ズレるため、 必ず `Date`
オブジェクト経由で local time に変換する。

## 公開関数

```js
extractDomain(url: string): string | null
formatLocalDate(d?: Date): string                  // "YYYY-MM-DD"
yesterdayLocal(now?: Date): string                 // "YYYY-MM-DD"
weekRangeFor(dateStr: string): { start, end }      // Mon-Sun inclusive
weekOfMonth(weekStart: string): { month, weekInMonth }
```

### `extractDomain(url)`
- URL → lowercase host name
- 不正な URL は `null`

### `formatLocalDate(d)`
- `Date` → `"YYYY-MM-DD"` (local TZ)
- 引数省略時は現在時刻

### `yesterdayLocal(now)`
- `now` (default: 現在時刻) の前日を `"YYYY-MM-DD"` で返す
- 月またぎ / 年またぎ対応

### `weekRangeFor(dateStr)`
- 任意の日付を含む週 (Mon〜Sun inclusive) を返す
- 月曜日入力 → そのまま、 日曜日入力 → 1 週間前の月曜から始まる週

### `weekOfMonth(weekStart)`
- 月内の週番号 (1-based、 Mon 起点)
- 月の最初の月曜が week 1

## 不変条件

- すべて純関数。 副作用なし。
- 入力 `Date` を mutate しない (内部で `new Date(d)` でコピー)
- TZ はホスト OS のローカル TZ に依存する (テストは JST 前提)

## テスト

`server/test/diary-date.test.js` (10 tests)

## 既知の制限

- TZ がホスト依存。 multi-region 化時は明示 TZ 引数が必要 (将来 Phase)
