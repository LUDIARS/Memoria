// zone 遷移 → event (純関数)。 状態の保存は呼び出し側 (state.ts)。

import type { PresenceEvent, PresenceState, Zone } from './types.js';

/** 前回 → 今回の zone から event を決める。 遷移なし・通り過ぎは null。 */
export function eventForTransition(prev: Zone, next: Zone): PresenceEvent | null {
  if (prev === next) return null;
  if (next === 'home') return 'arrive';
  if (prev === 'home') return 'depart';
  if (prev === 'away' && next === 'near') return 'approach';
  return null; // near → away (近くを通り過ぎた)
}

export interface DetectResult {
  event: PresenceEvent | null;
  next: PresenceState;
}

/**
 * 新しい zone を前回状態と比べて event を出す。
 * - 初回 (prev=null) は基準だけ保存して event なし (再起動直後の誤発火防止)。
 * - 同じ event が cooldown 内なら出さない (zone は更新する)。
 */
export function detectEvent(prev: PresenceState | null, zone: Zone, now: number, cooldownMs: number): DetectResult {
  if (!prev) return { event: null, next: { zone, lastEventAt: {} } };
  const event = eventForTransition(prev.zone, zone);
  if (!event) return { event: null, next: { ...prev, zone } };
  const last = prev.lastEventAt[event];
  if (typeof last === 'number' && now - last < cooldownMs) {
    return { event: null, next: { ...prev, zone } };
  }
  return { event, next: { zone, lastEventAt: { ...prev.lastEventAt, [event]: now } } };
}
