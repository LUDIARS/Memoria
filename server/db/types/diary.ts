// diary domain — diary_entries / weekly_reports / diary_settings
// Spec: spec/db/diary.md

export type DiaryStatus = 'pending' | 'done' | 'error';

export interface DiaryEntryRow {
  date: string;              // PK 'YYYY-MM-DD' (local TZ)
  summary: string | null;
  work_content: string | null;
  highlights: string | null;
  notes: string | null;
  metrics_json: string | null;
  github_commits_json: string | null;
  work_minutes: number | null;
  status: DiaryStatus;
  error: string | null;
  created_at: string;        // UTC ISO
  updated_at: string;        // UTC ISO
}

export interface WeeklyReportRow {
  week_start: string;        // PK 'YYYY-MM-DD'
  week_end: string;          // 'YYYY-MM-DD'
  month: string;             // 'YYYY-MM'
  week_in_month: number;
  summary: string | null;
  github_summary_json: string | null;
  status: DiaryStatus;
  error: string | null;
  created_at: string;        // UTC ISO
  updated_at: string;        // UTC ISO
}

export interface DiarySettingRow {
  key: string;               // PK
  value: string | null;
}
