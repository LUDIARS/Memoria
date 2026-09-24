/** Public Yahoo Kanto snapshot shared through HTTP, never through cross-repository imports. */
export const SOURCE_URL = 'https://transit.yahoo.co.jp/diainfo/area/4';
export const REFRESH_MS = 5 * 60 * 1000;
export interface RailLine {
  id: string;
  name: string;
  company: string;
  status: string;
  detail: string;
  url: string;
  disrupted: boolean;
}
export interface RailData { sourceUpdatedAt: string; lines: RailLine[] }
export interface RailSnapshot {
  version: 1;
  source: 'yahoo-kanto';
  sourceUrl: string;
  status: 'pending' | 'ok' | 'error';
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  error: string | null;
  lines: RailLine[];
}
