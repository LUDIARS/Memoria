const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DEFAULT_IMPORT_DAYS = 8;
const MAX_IMPORT_DAYS = 90;

/** JST calendar days of native log history read on each sync (`MEMORIA_LLM_IMPORT_DAYS`). */
export function importDays(): number {
  const configured = Number(process.env.MEMORIA_LLM_IMPORT_DAYS ?? String(DEFAULT_IMPORT_DAYS));
  if (!Number.isFinite(configured)) return DEFAULT_IMPORT_DAYS;
  return Math.min(MAX_IMPORT_DAYS, Math.max(1, Math.floor(configured)));
}

/** Start of the import window: 00:00 JST, `days - 1` days before today. */
export function importWindowStartMs(days: number, nowMs = Date.now()): number {
  const localDay = new Date(nowMs + JST_OFFSET_MS);
  localDay.setUTCHours(0, 0, 0, 0);
  localDay.setUTCDate(localDay.getUTCDate() - (days - 1));
  return localDay.getTime() - JST_OFFSET_MS;
}
