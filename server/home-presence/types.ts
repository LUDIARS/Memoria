// 帰宅・出発通知の型。 spec/feature/home-presence-notify.md。

import type { TaskFilter } from '../shared/task-select.js';
import type { NotifyDestination } from '../shared/notify-sink.js';

/** 自宅に対する現在地の区分。 */
export type Zone = 'home' | 'near' | 'away';

/** zone 遷移から作る出来事。 approach=近くに来た / arrive=着いた / depart=出発した。 */
export type PresenceEvent = 'approach' | 'arrive' | 'depart';

export const PRESENCE_EVENTS: readonly PresenceEvent[] = ['approach', 'arrive', 'depart'];

export interface HomePresenceConfig {
  /** マスタ。 OFF なら判定しない。 */
  enabled: boolean;
  /** 「近く」 とみなす半径 (m)。 */
  nearRadiusM: number;
  /** 境界の行き来で連発しないための余裕 (m)。 */
  hysteresisM: number;
  /** これより古い GPS では判定しない (分)。 */
  staleMin: number;
  /** 同じ event を再び出すまでの間隔 (分)。 */
  cooldownMin: number;
}

export interface PresenceRule {
  id: string;
  name: string;
  enabled: boolean;
  event: PresenceEvent;
  /** 空なら event ごとの既定文。 */
  message: string;
  /** タスク一覧を添えるか。 */
  includeTasks: boolean;
  filter: TaskFilter;
  /** 該当タスク 0 件でも一言を送るか (includeTasks=false なら常に送る)。 */
  sendWhenEmpty: boolean;
  destinations: NotifyDestination[];
}

/** 自宅の座標と半径。 source は出所 (work_location=作業場所の自宅 / weather=天気の固定座標)。 */
export interface HomePlace {
  lat: number;
  lon: number;
  radiusM: number;
  source: 'work_location' | 'weather';
  name: string;
}

export interface PresenceState {
  zone: Zone;
  /** event ごとの最終発火 (epoch ms)。 */
  lastEventAt: Partial<Record<PresenceEvent, number>>;
}

export interface GpsFix {
  lat: number;
  lon: number;
  /** epoch ms。 */
  recordedAt: number;
}
