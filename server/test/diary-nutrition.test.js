import { describe, it, expect } from 'vitest';
import { computeBmrMifflin, computeCaloricBalance, loadUserProfile } from '../diary/nutrition.js';
import { openDb } from '../db.js';

describe('computeBmrMifflin', () => {
  it('male 30y 70kg 175cm ≒ 1649', () => {
    const bmr = computeBmrMifflin({ age: 30, sex: 'male', weight_kg: 70, height_cm: 175 });
    expect(Math.round(bmr)).toBe(1649);
  });
  it('female 30y 60kg 165cm ≒ 1320', () => {
    const bmr = computeBmrMifflin({ age: 30, sex: 'female', weight_kg: 60, height_cm: 165 });
    expect(Math.round(bmr)).toBe(1320);
  });
  it('male offset is +5, female -161', () => {
    const baseProfile = { age: 25, weight_kg: 70, height_cm: 170 };
    const m = computeBmrMifflin({ ...baseProfile, sex: 'male' });
    const f = computeBmrMifflin({ ...baseProfile, sex: 'female' });
    expect(m - f).toBe(166);
  });
});

describe('computeCaloricBalance', () => {
  it('returns null when profile not configured', () => {
    const db = openDb(':memory:');
    const r = computeCaloricBalance(db, { intake: 2000, gpsDistanceM: 0 });
    expect(r).toBeNull();
    db.close();
  });
  it('full balance with profile + intake + walking', () => {
    const db = openDb(':memory:');
    db.exec(`INSERT INTO app_settings (key, value) VALUES
      ('user.age', '30'), ('user.sex', 'male'),
      ('user.weight_kg', '70'), ('user.height_cm', '175'),
      ('user.activity_level', 'moderate')`);
    const r = computeCaloricBalance(db, { intake: 2200, gpsDistanceM: 5000 });
    expect(r).not.toBeNull();
    expect(r.bmr).toBe(1649);
    expect(r.tdee).toBe(2556); // 1649 * 1.55
    expect(r.walking_kcal).toBe(210); // 5km * 70 * 0.6
    expect(r.expenditure_total).toBe(1859); // 1649 + 210
    expect(r.intake).toBe(2200);
    expect(r.diff_vs_target).toBe(2200 - 2556);
    expect(r.diff_vs_expenditure).toBe(2200 - 1859);
    db.close();
  });
  it('intake=null when not provided', () => {
    const db = openDb(':memory:');
    db.exec(`INSERT INTO app_settings (key, value) VALUES
      ('user.age', '30'), ('user.sex', 'male'),
      ('user.weight_kg', '70'), ('user.height_cm', '175')`);
    const r = computeCaloricBalance(db, { intake: null, gpsDistanceM: 0 });
    expect(r.intake).toBeNull();
    expect(r.diff_vs_target).toBeNull();
    db.close();
  });
});

describe('loadUserProfile', () => {
  it('returns null on incomplete profile', () => {
    const db = openDb(':memory:');
    db.exec(`INSERT INTO app_settings (key, value) VALUES
      ('user.age', '30'), ('user.sex', 'male')`); // missing weight/height
    expect(loadUserProfile(db)).toBeNull();
    db.close();
  });
  it('returns profile with defaults', () => {
    const db = openDb(':memory:');
    db.exec(`INSERT INTO app_settings (key, value) VALUES
      ('user.age', '40'), ('user.sex', 'female'),
      ('user.weight_kg', '55'), ('user.height_cm', '160')`);
    const p = loadUserProfile(db);
    expect(p).toEqual({
      age: 40, sex: 'female', weight_kg: 55, height_cm: 160, activity_level: 'moderate',
    });
    db.close();
  });
});
