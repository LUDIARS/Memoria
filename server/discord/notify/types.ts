// Discord タスク通知エンジンの型。 spec/feature/discord-task-notify.md。

export type TriggerKind = 'time' | 'random' | 'gps';
export type GpsEvent = 'arrive' | 'depart';
export type DeadlineFilter = 'all' | 'due_today_or_overdue';

/** 毎日決まった時刻に発火。 */
export interface TimeSpec {
  type: 'time';
  /** "HH:MM" (ローカル時刻)。 */
  at: string;
}

/** 1 日に count 回、 window 内のランダム時刻に発火。 */
export interface RandomSpec {
  type: 'random';
  /** ["HH:MM", "HH:MM"] (開始, 終了, ローカル時刻)。 */
  window: [string, string];
  /** 1 日あたりの発火回数 (>= 1)。 */
  count: number;
}

/** 自宅 geofence の帰宅 (arrive=外→内) / 出発 (depart=内→外) で発火。 */
export interface GpsSpec {
  type: 'gps';
  event: GpsEvent;
  /** geofence 半径 (m)。 */
  radius_m: number;
}

export type TriggerSpec = TimeSpec | RandomSpec | GpsSpec;

export interface NotifyFilter {
  /** ["all"] = 全カテゴリ、 それ以外は登録カテゴリ名の集合 (いずれか含むタスク)。 */
  categories: string[];
  /** "due_today_or_overdue" = 今日締切 or 期限超過のみ、 "all" = 期限不問。 */
  deadline: DeadlineFilter;
}

export interface NotifyTrigger {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  filter: NotifyFilter;
  /** 送信先 channel kind (announce/task/memo/bookmark/meal/recommend/activity)。 */
  channel: string;
}

/** 通知先に選べる channel kind。 layout.ts の生成 channel と揃える。 */
export const NOTIFY_CHANNEL_KINDS = [
  'announce', 'task', 'memo', 'bookmark', 'meal', 'recommend', 'activity',
] as const;
