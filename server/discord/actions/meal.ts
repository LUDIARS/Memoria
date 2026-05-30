// 食事登録。 Discord 添付画像を取得して既存 POST /api/meals (multipart) に委譲する
// (insertMeal + vision 解析まで既存パイプラインが行う)。

import { apiPostForm } from '../http.js';

export interface MealImage {
  url: string;
  name: string;
  contentType: string | null;
}

/** 添付画像をダウンロードして食事として登録する。 */
export async function createMeal(image: MealImage, note: string): Promise<string> {
  const dl = await fetch(image.url);
  if (!dl.ok) return `画像取得失敗 (${dl.status})`;
  const buf = Buffer.from(await dl.arrayBuffer());
  const form = new FormData();
  form.append('photo', new Blob([buf], { type: image.contentType ?? 'image/jpeg' }), image.name || 'meal.jpg');
  if (note) form.append('user_note', note);
  const res = await apiPostForm('/api/meals', form);
  if (!res.ok) return `食事登録失敗 (${res.status})`;
  return '食事を登録しました (解析中)';
}
