import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStructuringAxis,
  computeFocusAxis,
  computeRhythmAxis,
  computeCompletionAxis,
  computeSocialAxis,
  computePersonalityFeatures,
  type TaskFeatureInput,
  type DiaryFeatureInput,
  type ActivityFeatureInput,
} from './features.js';

function task(overrides: Partial<TaskFeatureInput> = {}): TaskFeatureInput {
  return {
    status: 'done',
    kind: 'task',
    created_at: '2026-01-01T00:00:00.000Z',
    due_at: null,
    category: null,
    ...overrides,
  };
}

test('computeStructuringAxis returns null below the minimum sample size', () => {
  assert.equal(computeStructuringAxis([task(), task()]), null);
});

test('computeStructuringAxis leans toward 計画型 when due_at is consistently set', () => {
  const tasks = Array.from({ length: 6 }, () => task({ due_at: '2026-02-01T00:00:00.000Z' }));
  const axis = computeStructuringAxis(tasks);
  assert.ok(axis);
  assert.equal(axis!.score, 1);
  assert.deepEqual(axis!.poles, ['即応型', '計画型']);
});

test('computeStructuringAxis leans toward 即応型 when due_at is never set', () => {
  const tasks = Array.from({ length: 6 }, () => task({ due_at: null }));
  const axis = computeStructuringAxis(tasks);
  assert.equal(axis!.score, -1);
});

test('computeFocusAxis leans toward 持続型 when tasks concentrate on one category', () => {
  const tasks = Array.from({ length: 6 }, () => task({ category: '開発' }));
  const axis = computeFocusAxis(tasks);
  assert.ok(axis);
  assert.ok(axis!.score > 0.5, `expected strongly 持続型 (score > 0.5), got ${axis!.score}`);
  assert.deepEqual(axis!.poles, ['探索型', '持続型']);
});

test('computeFocusAxis leans toward 探索型 when every task has a distinct category', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => task({ category: c }));
  const axis = computeFocusAxis(tasks);
  assert.equal(axis!.score, -1);
});

test('computeCompletionAxis reflects the done ratio', () => {
  const tasks = [
    ...Array.from({ length: 3 }, () => task({ status: 'done' })),
    ...Array.from({ length: 3 }, () => task({ status: 'todo' })),
  ];
  const axis = computeCompletionAxis(tasks);
  assert.equal(axis!.score, 0);
});

test('computeSocialAxis is omitted entirely when there is no Discord activity', () => {
  const activities: ActivityFeatureInput[] = Array.from({ length: 25 }, (_, i) => ({
    kind: 'git_commit',
    occurred_at: new Date(2026, 0, 1, i % 24).toISOString(),
  }));
  assert.equal(computeSocialAxis(activities), null);
});

test('computeSocialAxis leans toward 協調型 when Discord activity dominates', () => {
  const activities: ActivityFeatureInput[] = Array.from({ length: 25 }, (_, i) => ({
    kind: 'discord_message',
    occurred_at: new Date(2026, 0, 1, i % 24).toISOString(),
  }));
  const axis = computeSocialAxis(activities);
  assert.ok(axis);
  assert.equal(axis!.score, 1);
});

test('computeRhythmAxis leans toward 規則型 when activity concentrates on one hour and work_minutes is stable', () => {
  const activities: ActivityFeatureInput[] = Array.from({ length: 25 }, () => ({
    kind: 'git_commit',
    occurred_at: new Date(2026, 0, 1, 10).toISOString(),
  }));
  const diaries: DiaryFeatureInput[] = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    work_minutes: 120,
  }));
  const axis = computeRhythmAxis(activities, diaries);
  assert.ok(axis);
  assert.ok(axis!.score < 0, `expected 規則型 (negative), got ${axis!.score}`);
});

test('computeRhythmAxis returns null when neither signal has enough samples', () => {
  assert.equal(computeRhythmAxis([], []), null);
});

test('computePersonalityFeatures drops axes with insufficient samples instead of zero-filling them', () => {
  const result = computePersonalityFeatures(
    { tasks: [], diaries: [], activities: [] },
    { sampleWindowDays: 90, now: () => new Date('2026-07-17T00:00:00.000Z') }
  );
  assert.deepEqual(result.axes, []);
  assert.equal(result.computedAt, '2026-07-17T00:00:00.000Z');
  assert.deepEqual(result.counts, { tasks: 0, diaries: 0, activities: 0 });
});
