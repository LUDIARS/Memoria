// meal API request/response types
// Spec: spec/interface/meal.md

import type { MealRow, MealAiStatus } from '../../db/types/meal.js';

export interface MealsListQuery {
  date?: string;                  // 'YYYY-MM-DD'
  limit?: number;
}

export interface MealsListResponse {
  items: MealRow[];
}

export interface MealManualCreateRequest {
  eaten_at?: string;              // UTC ISO; default = now
  description?: string;
  calories?: number;
  user_note?: string;
}

export interface MealUpdateRequest {
  description?: string | null;
  calories?: number | null;
  eaten_at?: string;
  lat?: number | null;
  lon?: number | null;
  location_label?: string | null;
  user_note?: string | null;
  user_corrected_description?: string | null;
  user_corrected_calories?: number | null;
  ai_status?: MealAiStatus;
}

export interface MealAdditionRequest {
  name: string;
  calories?: number;
}
