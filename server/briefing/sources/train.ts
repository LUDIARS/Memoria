// 運行情報ソース。 鉄道遅延情報のjson (rti-giken、 全国・API キー不要) を取得し、
// 設定された対象路線でフィルタする。 https://tetsudo.rti-giken.jp/free/delay.json
//
// delay.json は「現在遅延が出ている路線だけ」 を配列で返す。 平常運転の路線は
// 含まれないため、 「対象路線が配列に無い = 平常」 と解釈する。

import type { SectionBlock } from '../types.js';

const DELAY_ENDPOINT = 'https://tetsudo.rti-giken.jp/free/delay.json';
const FETCH_TIMEOUT_MS = 10_000;
const HEADING = '🚆 運行情報';

interface DelayEntry {
  name: string;        // 路線名 (例 '山手線')
  company: string;     // 事業者名 (例 'JR東日本')
  lastupdate_gmt?: number;
}

/** 空白・全半角を無視した緩い部分一致。 「JR山手線」 と「山手線」 を一致させる。 */
function normalize(s: string): string {
  return s.replace(/[\s　]/g, '');
}

/** delay.json を取得して対象路線にかかる遅延だけ返す。 best-effort で例外は投げる。 */
async function fetchMatchedDelays(lines: string[]): Promise<DelayEntry[]> {
  const res = await fetch(DELAY_ENDPOINT, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Memoria-briefing/1.0 (+https://github.com/LUDIARS)' },
  });
  if (!res.ok) throw new Error(`train delay: ${res.status} ${res.statusText}`);
  const all = await res.json() as DelayEntry[];
  if (!Array.isArray(all)) throw new Error('train delay: unexpected payload');
  const wanted = lines.map(normalize);
  return all.filter((e) => {
    const n = normalize(e.name);
    return wanted.some((w) => n.includes(w) || w.includes(n));
  });
}

export async function buildTrainBlock(lines: string[]): Promise<SectionBlock> {
  if (!lines.length) {
    return {
      key: 'train',
      heading: HEADING,
      lines: ['（対象路線が未設定です — 設定で briefing.train.lines に路線名を登録してください）'],
    };
  }
  try {
    const matched = await fetchMatchedDelays(lines);
    if (!matched.length) {
      return { key: 'train', heading: HEADING, lines: [`✅ 対象路線（${lines.join('・')}）に遅延情報はありません`] };
    }
    return {
      key: 'train',
      heading: HEADING,
      lines: matched.map((e) => `⚠️ ${e.company} ${e.name}：遅延あり`),
    };
  } catch (e: unknown) {
    return { key: 'train', heading: HEADING, lines: [`⚠️ 取得失敗（${e instanceof Error ? e.message : String(e)}）`] };
  }
}
