/**
 * 集計期間の純関数。 月は `YYYY-MM`、 境界はタイムゾーン固定オフセット (既定 JST) で切る。
 */

export const JST_OFFSET_MINUTES = 9 * 60;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(month: string): { year: number; month: number } {
  const m = MONTH_RE.exec(month.trim());
  if (!m) throw new Error(`invalid month: ${month} (YYYY-MM)`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function daysInMonth(month: string): number {
  const { year, month: mm } = parseMonth(month);
  return new Date(Date.UTC(year, mm, 0)).getUTCDate();
}

/** ISO 日時を固定オフセットの暦月 `YYYY-MM` に寄せる。 */
export function monthOf(iso: string, offsetMinutes = JST_OFFSET_MINUTES): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid date: ${iso}`);
  const local = new Date(t + offsetMinutes * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 月を検索用の日付窓 (UTC の YYYY-MM-DD 両端含む) に分ける。
 * GitHub 検索は 1 クエリ 1000 件までなので小さく切り、 タイムゾーンのずれ分として前後 1 日を足す。
 */
export function searchWindows(month: string, spanDays = 7): { from: string; to: string }[] {
  if (spanDays < 1) throw new Error('spanDays must be >= 1');
  const { year, month: mm } = parseMonth(month);
  const start = new Date(Date.UTC(year, mm - 1, 1) - 86_400_000);
  const end = new Date(Date.UTC(year, mm, 1));
  const out: { from: string; to: string }[] = [];
  for (let cur = start; cur <= end;) {
    const last = new Date(Math.min(cur.getTime() + (spanDays - 1) * 86_400_000, end.getTime()));
    out.push({ from: ymd(cur), to: ymd(last) });
    cur = new Date(last.getTime() + 86_400_000);
  }
  return out;
}

/** 日付窓を 1 日ずつに割る (1 窓が 1000 件を超えたとき用)。 */
export function splitWindowByDay(w: { from: string; to: string }): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let t = Date.parse(`${w.from}T00:00:00Z`); t <= Date.parse(`${w.to}T00:00:00Z`); t += 86_400_000) {
    const d = ymd(new Date(t));
    out.push({ from: d, to: d });
  }
  return out;
}
