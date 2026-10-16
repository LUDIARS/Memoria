/** Pure time-axis and navigation rules; all user-entered wall-clock values are JST. */
export interface HistoryWindow { from: number; to: number; now: number }
export interface TimeTick { ts: number; ratio: number; day: string; time: string }

export function historyTicks(from: number, to: number): TimeTick[] {
  const intervals = to - from === 7 * 86400 ? 7 : 6;
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const ratio = index / intervals;
    const ts = from + (to - from) * ratio;
    const date = new Date(ts * 1000);
    return { ts, ratio,
      day: date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }),
      time: date.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  });
}

export function jstInputValue(ts: number): string {
  return new Date((ts + 9 * 3600) * 1000).toISOString().slice(0, 16);
}

export function parseJstInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}:00+09:00`) / 1000;
  return Number.isFinite(parsed) && jstInputValue(parsed) === value ? parsed : null;
}

export function shiftedHistoryStart(window: HistoryWindow, direction: -1 | 1): number | null {
  if (direction === 1 && window.to >= window.now) return null;
  if (direction === -1 && window.from <= 0) return null;
  return Math.max(0, window.from + direction * (window.to - window.from));
}
