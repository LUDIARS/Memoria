// diary API request/response types
// Spec: spec/api/diary.md

import type { DiaryEntryRow, WeeklyReportRow } from '../../db/types/diary.js';
import type { DigSessionRow } from '../../db/types/dig.js';

export interface DiaryMonthResponse {
  month: string;                  // 'YYYY-MM'
  start: string;                  // 'YYYY-MM-DD'
  end: string;                    // 'YYYY-MM-DD'
  days: { date: string; status: 'absent' | 'pending' | 'done' | 'error' }[];
}

export interface DiaryDetailResponse extends DiaryEntryRow {
  /** generation 後にサーバ側で再計算した metrics (ブラウザ閲覧 + 食事 + 軌跡 + 開発活動). */
  live_metrics?: unknown;
  metrics?: unknown;
}

export interface DiaryNotesPatchRequest {
  notes: string;
}

export interface DiaryImproveRequest {
  improve: string;                // free-form 改善指示
}

export interface DiaryDigListResponse {
  items: DigSessionRow[];
}

export interface WeeklyListResponse {
  items: WeeklyReportRow[];
}
