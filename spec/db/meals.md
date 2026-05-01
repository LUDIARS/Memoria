# `db/meals.js` — 食事記録 CRUD

## 目的

`meals` テーブルの DAO。 写真 / EXIF / GPS / Vision API / 追加項目 /
栄養素 / カロリー補正 の各列を扱う。 PR #90 で追加されたテーブル。

## 公開関数

```js
insertMeal(db, m): id
getMeal(db, id): Meal | null
listMeals(db, { from?, to?, limit?, offset? }): Meal[]
countMeals(db, { from?, to? }): number
updateMeal(db, id, patch): void
deleteMeal(db, id): void
listPendingMeals(db, { limit? }): Meal[]
listMealsForDate(db, dateStr): Meal[]
```

### `Meal` shape (主要列)

```ts
{
  id, photo_path, eaten_at, eaten_at_source,
  lat, lon, location_label, location_source,
  description, calories, items_json, nutrients_json,
  ai_status: 'pending' | 'done' | 'error',
  ai_error,
  user_note, user_corrected_description, user_corrected_calories,
  additions_json,                  // [{ name, calories?, added_at }]
  created_at, updated_at,
}
```

JSON 文字列カラム (`items_json` / `nutrients_json` / `additions_json`)
は呼出側で `JSON.parse` する。 DAO 自体は文字列のまま返す。

### `listMeals` パラメータ
- `from` / `to`: ISO8601、 `eaten_at` の範囲フィルタ
- `limit` / `offset`: ページング (default 100 / 0)
- ソートは `eaten_at DESC` 固定

### `updateMeal` 部分更新
- `patch` の任意フィールドのみ UPDATE (NULL も明示反映)
- `updated_at` は自動更新

### `listPendingMeals`
- `ai_status = 'pending'` のみ
- AI 解析キューが消化対象を取得するために使用

### `listMealsForDate`
- `dateStr = "YYYY-MM-DD"` (local time)
- `date(eaten_at, 'localtime')` で当日に該当する meal を時刻順 ASC で返す
- 日記の食事ブロック組立に使用

## 不変条件

- prepared statements、 SQL injection なし
- `additions_json` は配列の JSON シリアライズ (空 = NULL)
- `eaten_at` は UTC ISO8601 (frontend の datetime-local は server 側で変換)

## テスト

`server/test/db-meals.test.js` (6 tests, in-memory SQLite)

- insert + get roundtrip
- listMeals 範囲フィルタ + countMeals 同条件で一致
- updateMeal でフィールド部分更新 (description は変えない、 user_corrected_* のみ)
- listPendingMeals で ai_status='pending' のみ取得
- deleteMeal で行削除
- listMealsForDate で日付フィルタ

## 既知の制限

- JSON カラムを DB 側で query できない (Drizzle 化時に `text({ mode: 'json' })` で改善予定)
- `eaten_at` の TZ 解釈は呼出側次第 (datetime-local ↔ ISO の変換は routes 層)
- `listMealsForDate` の `'localtime'` は SQLite ホストの TZ を使用 — multi-region では要再設計
