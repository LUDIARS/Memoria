// ─── カロリーバランス計算 ───────────────────────────────────────
//
// app_settings の `user.*` から profile を読み出し、 BMR / TDEE を計算。
// 摂取 (食事合計) / 消費 (BMR + 軌跡歩行) / 適正 (TDEE) / 過不足 を出す。
//
// プロファイル未設定の場合は null を返し、 UI 側で「設定してください」 と促す。

import { getAppSettings } from '../db.js';

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export function loadUserProfile(db) {
  const s = getAppSettings(db);
  const age = parseFloat(s['user.age']);
  const sex = (s['user.sex'] || '').trim().toLowerCase();
  const weight = parseFloat(s['user.weight_kg']);
  const height = parseFloat(s['user.height_cm']);
  const activity = (s['user.activity_level'] || 'moderate').trim().toLowerCase();
  if (!isFinite(age) || !isFinite(weight) || !isFinite(height) || (sex !== 'male' && sex !== 'female')) {
    return null;
  }
  return { age, sex, weight_kg: weight, height_cm: height, activity_level: activity };
}

export function computeBmrMifflin(profile) {
  // Mifflin-St Jeor
  const base = 10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * profile.age;
  return profile.sex === 'male' ? base + 5 : base - 161;
}

export function computeCaloricBalance(db, { intake, gpsDistanceM }) {
  const profile = loadUserProfile(db);
  if (!profile) return null;
  const bmr = Math.round(computeBmrMifflin(profile));
  const factor = ACTIVITY_FACTORS[profile.activity_level] ?? ACTIVITY_FACTORS.moderate;
  const tdee = Math.round(bmr * factor);
  // 歩行による追加消費 (m → kcal): 1 km あたり 体重 × 0.6 kcal の概算
  const walkingKcal = Math.round((gpsDistanceM || 0) / 1000 * profile.weight_kg * 0.6);
  // 1 日消費 = BMR + 軌跡からの歩行追加 (TDEE の活動係数とは別の上乗せで見せる)
  const expenditure = bmr + walkingKcal;
  const intakeNum = (typeof intake === 'number' && isFinite(intake)) ? intake : null;
  return {
    profile,
    bmr,
    tdee,
    walking_kcal: walkingKcal,
    intake: intakeNum,
    expenditure_total: expenditure, // BMR + walking
    diff_vs_target: intakeNum != null ? intakeNum - tdee : null,
    diff_vs_expenditure: intakeNum != null ? intakeNum - expenditure : null,
  };
}
