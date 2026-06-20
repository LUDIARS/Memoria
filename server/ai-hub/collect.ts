// ai-hub — 前日コンテキストの組み立て。
// activity_events (主) + session-log (補助) を 1 つのプレーンテキストに束ねて
// article_topics LLM への入力にする。
// Spec: spec/feature/ai-hub.md §collect.ts

import type BetterSqlite3 from 'better-sqlite3';
import { activityEventsForDate } from '../db.js';
import { readSessionLog } from './session-log.js';

type Db = BetterSqlite3.Database;

/** 1 イベントを 1 行に整形する (kind / source / 本文)。 */
function formatEvent(e: {
  kind: string;
  occurred_at: string;
  source: string | null;
  content: string | null;
}): string {
  const time = e.occurred_at.slice(11, 16) || e.occurred_at;
  const src = e.source ? ` [${e.source}]` : '';
  const body = (e.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `- ${time} (${e.kind})${src} ${body}`.trimEnd();
}

export interface DayContext {
  dateStr: string;
  text: string;
  activityCount: number;
  hasSessionLog: boolean;
}

/**
 * 指定日 (YYYY-MM-DD) の前日コンテキスト文字列を組む。
 * activity_events を時系列で列挙し、 session-log があれば末尾に付ける。
 */
export function buildDayContext(db: Db, dateStr: string): DayContext {
  const events = activityEventsForDate(db, dateStr);
  const lines = events.map((e) => formatEvent(e));
  const sessionLog = readSessionLog(dateStr);

  const parts: string[] = [];
  parts.push(`# ${dateStr} の作業ログ`);
  parts.push('');
  parts.push(`## 活動イベント (activity_events, ${events.length} 件)`);
  parts.push(lines.length ? lines.join('\n') : '(イベントなし)');

  if (sessionLog) {
    parts.push('');
    parts.push('## セッションログ (補助)');
    // session-log は長くなりうるので冒頭を多めに残しつつ上限を設ける。
    parts.push(sessionLog.slice(0, 12_000));
  }

  return {
    dateStr,
    text: parts.join('\n'),
    activityCount: events.length,
    hasSessionLog: !!sessionLog,
  };
}
