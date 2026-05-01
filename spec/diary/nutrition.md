# `diary/nutrition.js` — BMR / TDEE / カロリーバランス

## 目的

`app_settings` の user.* プロファイルから BMR / TDEE を計算し、
食事 (摂取) と GPS (歩行消費) を合わせて 1 日のカロリーバランスを出す。

## 公開関数

```js
loadUserProfile(db): { age, sex, weight_kg, height_cm, activity_level } | null
computeBmrMifflin(profile): number
computeCaloricBalance(db, { intake, gpsDistanceM }): {
  profile, bmr, tdee, walking_kcal, intake,
  expenditure_total, diff_vs_target, diff_vs_expenditure,
} | null
```

### `loadUserProfile(db)`
- `app_settings` から `user.age` `user.sex` `user.weight_kg`
  `user.height_cm` `user.activity_level` を読む
- 必須フィールド (age / sex / weight / height) のいずれかが欠けていたら
  `null` を返す
- `activity_level` の default は `'moderate'`

### `computeBmrMifflin(profile)`
- **Mifflin-St Jeor 式**:
  - 男性: `10 * weight_kg + 6.25 * height_cm - 5 * age + 5`
  - 女性: `10 * weight_kg + 6.25 * height_cm - 5 * age - 161`
- 男女差は固定で +5 / -161 (両性別 = 166 kcal 差)

### `computeCaloricBalance(db, { intake, gpsDistanceM })`
- `loadUserProfile()` 失敗時は `null`
- 計算:
  - `bmr = computeBmrMifflin(profile)` (整数丸め)
  - `tdee = bmr * ACTIVITY_FACTORS[activity_level]` (整数丸め)
  - `walking_kcal = (gpsDistanceM / 1000) * weight_kg * 0.6` (整数丸め)
  - `expenditure_total = bmr + walking_kcal`
  - `diff_vs_target = intake - tdee` (intake null なら null)
  - `diff_vs_expenditure = intake - expenditure_total` (同上)

### `ACTIVITY_FACTORS` (private)

| 値 | 倍率 |
|---|---|
| `sedentary` | 1.2 |
| `light` | 1.375 |
| `moderate` | 1.55 |
| `active` | 1.725 |
| `very_active` | 1.9 |

## 不変条件

- 純粋に同期 (better-sqlite3 が同期 API)。
- `db` は read-only として扱う (`getAppSettings` のみ呼び出し)。
- 整数丸め後に算出するので、 BMR + walking_kcal が tdee と僅かに合わない
  ことがある (= 設計通り)。

## テスト

`server/test/diary-nutrition.test.js` (8 tests)

- 男性 30y/70kg/175cm → BMR 1649 kcal
- 女性 30y/60kg/165cm → BMR 1320 kcal
- 男女オフセット差 166 kcal
- profile 未設定で `null`
- intake null → diff も null
- 完全プロファイル + 5km 歩行 → walking_kcal=210, expenditure=1859

## 既知の制限

- 体脂肪率を使う Katch-McArdle 式は未対応 (Mifflin のみ)
- 歩行 kcal の係数 0.6 は概算 (個人差大)
- 階段 / 坂 / 走行は判定無し
