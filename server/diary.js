// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.
//
// This file used to hold the entire implementation. It has since been split
// into focused modules under ./diary/ — this shim re-exports everything so
// existing `import ... from './diary.js'` callers keep working unchanged.

export * from './diary/date.js';
export * from './diary/gps.js';
export * from './diary/nutrition.js';
export * from './diary/github.js';
export * from './diary/aggregate.js';
export * from './diary/prompt.js';
export * from './diary/generate.js';
