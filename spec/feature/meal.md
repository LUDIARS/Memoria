# meal — 食事写真 + EXIF + 栄養推定

## 概要
食事写真を multipart で投稿 → EXIF (撮影時刻 / GPS) 抽出 → Vision LLM で内容説明 + カロリー / 栄養素推定。 写真なし「手動入力」 経路もあり。 おかわり等の追加分は `additions_json` に追記。

## ユースケース
- 食ったものを撮って放り込むだけで栄養記録
- LLM の説明 / カロリーを手動補正 (`user_corrected_*`)
- ユーザプロファイル (年齢 / 性別 / 体重 / 身長 / 活動量) から適正カロリー計算
- 後から「あれ食べた」 を追加 (`/api/meals/:id/additions`)

## 画面 / 入口
- `🍽 食事` タブ (top-level) → カメラ / ファイル選択 → POST
- 「写真なし手動」 経路: `POST /api/meals/manual`
- 詳細: 補正フィールド + 追加 / 編集 / 再分析 (`/api/meals/:id/reanalyze`)

## データ
- [meals](../data/meal.md) — photo_path / eaten_at / eaten_at_source (manual/exif/gps/inference) / lat/lon / location_label / location_source / description / calories / items_json / nutrients_json / ai_status / user_note / user_corrected_* / additions_json
- 写真本体: `<DATA>/meals/<id>-<8hex>.<ext>` (DB は `photo_path` のみ)
- 場所推定の入力: `gps_locations` (撮影時刻に最も近い GPS 点を `resolveMealLocation`)

## API
- [meal.md](../interface/meal.md) — `/api/meals` (multipart 投稿) / `/api/meals/manual` (JSON 投稿) / `/api/meals*` (一覧 / 詳細 / 写真 / 補正 / 削除 / 再分析) / `/api/meals/:id/additions*`
- 全 endpoint は `features.meals.enabled` / `features.meals.visible` フラグで gate

## シェア可能か
**local-only**

食事は Hub にシェアできない (`/api/multi/share` 対象外)。 健康情報の機微度を考慮した意図的設計。

## プライバシー観点
- **個人データを保持するテーブル**: `meals` (食事内容、 撮影位置 lat/lon、 栄養補正データ。 健康・行動情報の機微度高)、 写真ファイル本体 (EXIF 込み)、 `user.age` / `user.sex` / `user.weight_kg` / `user.height_cm` (`app_settings`)。
- **LLM プロバイダに送る情報**: タスク `meal_vision` (Sonnet default) で **写真 image data + EXIF メタ** を Claude / OpenAI / Gemini に送り内容説明 + カロリー推定。 タスク `meal_calorie` で食品名 (description) のみ送って手動補正のカロリー推定。 ユーザの API key スコープ。 LLM 出力の妥当性は人間が確認する前提。
- **共有時に外部に出ない情報**: 全部 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/meals/:id` で DB 行削除 + 写真ファイル `unlinkSync`。 Vision queue に積まれた job は `ai_status=cancelled` 相当のスキップ (実装上は対象 row が消えればワーカ側でスルー)。
