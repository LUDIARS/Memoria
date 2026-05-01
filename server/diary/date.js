// Date helpers used across the diary modules.

export function extractDomain(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

/** YYYY-MM-DD in local time for a given Date instance (or now). */
export function formatLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date string for "yesterday" relative to the supplied moment. */
export function yesterdayLocal(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}

/** Monday → Sunday inclusive range that contains `dateStr`. */
export function weekRangeFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  // Mon=1,...,Sun=7 (ISO). JS getDay: Sun=0,Mon=1,...
  const dow = d.getDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + offsetToMonday);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: formatLocalDate(mon), end: formatLocalDate(sun) };
}

/** Which week-of-month does `weekStart` fall in (1-based, by Mon). */
export function weekOfMonth(weekStart) {
  const d = new Date(weekStart + 'T00:00:00');
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Find first Monday in the month containing weekStart's Monday.
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const dow = firstDay.getDay();
  const firstMon = new Date(firstDay);
  firstMon.setDate(1 + ((dow === 0 ? 1 : (8 - dow) % 7)));
  const diffDays = Math.round((d - firstMon) / 86400000);
  const idx = Math.floor(diffDays / 7) + 1;
  return { month, weekInMonth: idx };
}
