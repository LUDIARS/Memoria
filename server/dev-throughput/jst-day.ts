// JST の暦日を扱う純関数。 集計の 1 日は JST の 0:00〜23:59:59。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 時刻 (ISO 文字列か Date) を JST の YYYY-MM-DD にする。 読めない値は null。 */
export function jstDayOf(value: string | Date): string | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** now を含む直近 count 日を新しい順に返す。 */
export function recentJstDays(now: Date, count: number): string[] {
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = jstDayOf(new Date(now.getTime() - i * DAY_MS));
    if (day) days.push(day);
  }
  return days;
}

/** GitHub 検索の committer-date に渡す JST の範囲 (両端を含む)。 */
export function jstDayRange(day: string): string {
  if (!DAY_PATTERN.test(day)) throw new Error(`invalid day: ${day}`);
  return `${day}T00:00:00+09:00..${day}T23:59:59+09:00`;
}
