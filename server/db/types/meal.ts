// meal domain — meals
// Spec: spec/db/meal.md

export type MealEatenAtSource = 'manual' | 'exif' | 'gps' | 'inference';
export type MealAiStatus = 'pending' | 'running' | 'done' | 'error';

export interface MealRow {
  id: number;
  photo_path: string;
  eaten_at: string;             // UTC ISO
  eaten_at_source: MealEatenAtSource;
  lat: number | null;
  lon: number | null;
  location_label: string | null;
  location_source: string | null;
  description: string | null;
  calories: number | null;
  items_json: string | null;       // JSON: [{name, calories, ...}]
  nutrients_json: string | null;   // JSON: { protein, fat, carbs, ... }
  ai_status: MealAiStatus;
  ai_error: string | null;
  user_note: string | null;
  user_corrected_description: string | null;
  user_corrected_calories: number | null;
  additions_json: string | null;   // JSON: 追加分 (おかわり等)
  created_at: string;
  updated_at: string;
}
