import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface JsonObject { [key: string]: unknown }

export async function forEachJsonLine(path: string, visit: (row: JsonObject) => void): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A provider can leave a partial final JSONL line while the session is active.
        continue;
      }
      const row = object(value);
      if (row) visit(row);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function timeMs(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

const JST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function jstDate(time: number | Date): string {
  return JST_DATE.format(typeof time === 'number' ? new Date(time) : time);
}
