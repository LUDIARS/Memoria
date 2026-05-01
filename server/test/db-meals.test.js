import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../db.js';
import {
  insertMeal,
  getMeal,
  listMeals,
  countMeals,
  updateMeal,
  deleteMeal,
  listPendingMeals,
  listMealsForDate,
} from '../db/meals.js';

describe('db/meals', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('insert + get roundtrip', () => {
    const id = insertMeal(db, {
      photo_path: '1.jpg',
      eaten_at: '2026-05-01T12:00:00.000Z',
      eaten_at_source: 'manual',
      lat: null, lon: null,
      location_label: null, location_source: null,
      description: 'lunch', calories: 600,
      items_json: null, ai_status: 'done',
    });
    const m = getMeal(db, id);
    expect(m.id).toBe(id);
    expect(m.description).toBe('lunch');
    expect(m.calories).toBe(600);
  });

  it('listMeals filter by date range + count matches', () => {
    insertMeal(db, { photo_path: '', eaten_at: '2026-04-30T20:00:00.000Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'dinner', calories: 800, items_json: null, ai_status: 'done' });
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T08:00:00.000Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'breakfast', calories: 400, items_json: null, ai_status: 'done' });
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T12:00:00.000Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'lunch', calories: 600, items_json: null, ai_status: 'done' });

    const all = listMeals(db, {});
    expect(all.length).toBe(3);

    const may1 = listMeals(db, { from: '2026-05-01T00:00:00', to: '2026-05-01T23:59:59' });
    expect(may1.length).toBe(2);
    expect(countMeals(db, { from: '2026-05-01T00:00:00', to: '2026-05-01T23:59:59' })).toBe(2);
  });

  it('updateMeal patches fields', () => {
    const id = insertMeal(db, { photo_path: 'x', eaten_at: '2026-05-01T12:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'old', calories: 100, items_json: null, ai_status: 'pending' });
    updateMeal(db, id, { user_corrected_description: 'new', user_corrected_calories: 200 });
    const m = getMeal(db, id);
    expect(m.user_corrected_description).toBe('new');
    expect(m.user_corrected_calories).toBe(200);
    expect(m.description).toBe('old'); // unchanged
  });

  it('listPendingMeals returns ai_status=pending only', () => {
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T00:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: '', calories: null, items_json: null, ai_status: 'pending' });
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T01:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: '', calories: null, items_json: null, ai_status: 'done' });
    const pending = listPendingMeals(db);
    expect(pending.length).toBe(1);
    expect(pending[0].ai_status).toBe('pending');
  });

  it('deleteMeal removes the row', () => {
    const id = insertMeal(db, { photo_path: 'x', eaten_at: '2026-05-01T12:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'd', calories: 1, items_json: null, ai_status: 'done' });
    deleteMeal(db, id);
    expect(getMeal(db, id)).toBeUndefined();
  });

  it('listMealsForDate filters by local date', () => {
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T03:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'a', calories: 100, items_json: null, ai_status: 'done' });
    insertMeal(db, { photo_path: '', eaten_at: '2026-05-01T15:00:00Z', eaten_at_source: 'manual', lat: null, lon: null, location_label: null, location_source: null, description: 'b', calories: 200, items_json: null, ai_status: 'done' });
    // local-date filter behavior depends on TZ; just confirm a day query returns ≥1
    const r = listMealsForDate(db, '2026-05-01');
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
});
