// Discord タスク通知エンジンの型。 spec/feature/discord-task-notify.md。

// 帰宅・出発 (旧 gps 種別) は home-presence ドメインへ移した (spec/feature/home-presence-notify.md)。

import type { TaskFilter } from '../../shared/task-select.js';

export type { DeadlineFilter } from '../../shared/task-select.js';
export type TriggerKind = 'time' | 'random';

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

export type TriggerSpec = TimeSpec | RandomSpec;

export type NotifyFilter = TaskFilter;

export interface NotifyTrigger {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  filter: NotifyFilter;
  /** 送信先 channel kind (announce/task/memo/bookmark/meal/recommend/activity)。 */
  channel: string;
}

/** 通知先に選べる channel kind。 */
export { DISCORD_CHANNEL_KINDS as NOTIFY_CHANNEL_KINDS } from '../../shared/notify-sink.js';
