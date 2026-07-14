// 防災ソース。 2 系統 (どちらも無料・キー不要):
//   - 地震: P2P地震情報 API (https://api.p2pquake.net/v2/history?codes=551)
//   - 気象警報・注意報: 気象庁 防災情報 JSON (エリアコード指定時のみ)
//
// 1 ブロックにまとめて返す。 どちらかが失敗してももう一方は出す。

import type { SectionBlock } from '../types.js';

const P2P_ENDPOINT = 'https://api.p2pquake.net/v2/history?codes=551&limit=1';
const JMA_WARNING_BASE = 'https://www.jma.go.jp/bosai/warning/data/warning';
const FETCH_TIMEOUT_MS = 12_000;
const EQ_RECENT_HOURS = 12;
const HEADING = '🚨 防災情報';

/** P2P maxScale → 震度ラベル。 */
function scaleLabel(scale: number): string {
  const map: Record<number, string> = {
    10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7',
  };
  return map[scale] ?? '不明';
}

interface P2PQuake {
  earthquake?: {
    time?: string;
    maxScale?: number;
    hypocenter?: { name?: string; magnitude?: number };
  };
}

/** "2026/06/09 07:26:00" (JST) を Date に。 失敗時 null。 */
function parseJstTime(s: string): Date | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  // JST (+09:00) として解釈。
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function earthquakeLine(minScale: number): Promise<string | null> {
  try {
    const res = await fetch(P2P_ENDPOINT, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`p2pquake: ${res.status}`);
    const list = await res.json() as P2PQuake[];
    const eq = list[0]?.earthquake;
    if (!eq?.time) return null;
    const when = parseJstTime(eq.time);
    if (!when) return null;
    const ageH = (Date.now() - when.getTime()) / 3_600_000;
    if (ageH > EQ_RECENT_HOURS) return null;                  // 古い地震は出さない
    if ((eq.maxScale ?? -1) < minScale) return null;          // 小さい揺れは出さない
    const place = eq.hypocenter?.name || '震源不明';
    const mag = eq.hypocenter?.magnitude;
    const magStr = typeof mag === 'number' && mag >= 0 ? ` M${mag.toFixed(1)}` : '';
    const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    return `🌐 地震 ${hhmm} ${place}${magStr} 最大震度${scaleLabel(eq.maxScale ?? -1)}`;
  } catch {
    return null;   // best-effort
  }
}

// 気象庁 警報・注意報コード → 名称 (主要なものだけ。 未知コードは「警報/注意報」)。
const WARNING_NAMES: Record<string, string> = {
  '02': '暴風雪警報', '03': '大雨警報', '04': '洪水警報', '05': '暴風警報',
  '06': '大雪警報', '07': '波浪警報', '08': '高潮警報',
  '10': '大雨注意報', '12': '大雪注意報', '13': '風雪注意報', '14': '雷注意報',
  '15': '強風注意報', '16': '波浪注意報', '17': '融雪注意報', '18': '洪水注意報',
  '19': '高潮注意報', '20': '濃霧注意報', '21': '乾燥注意報', '22': 'なだれ注意報',
  '23': '低温注意報', '24': '霜注意報', '25': '着氷注意報', '26': '着雪注意報',
  '32': '大雨特別警報', '33': '暴風特別警報', '35': '大雪特別警報', '36': '波浪特別警報',
};

interface JmaWarning { code?: string; status?: string }
interface JmaArea { warnings?: JmaWarning[] }
interface JmaAreaType { areas?: JmaArea[] }
interface JmaWarningDoc { areaTypes?: JmaAreaType[] }

async function warningLines(areaCode: string): Promise<string[]> {
  try {
    const res = await fetch(`${JMA_WARNING_BASE}/${areaCode}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jma: ${res.status}`);
    const doc = await res.json() as JmaWarningDoc;
    const active = new Set<string>();
    for (const at of doc.areaTypes ?? []) {
      for (const area of at.areas ?? []) {
        for (const w of area.warnings ?? []) {
          const code = w.code ?? '';
          const status = w.status ?? '';
          if (!code || code === '00') continue;
          if (status === '解除' || status === '発表警報・注意報はなし') continue;
          active.add(WARNING_NAMES[code] ?? `警報・注意報(code ${code})`);
        }
      }
    }
    if (!active.size) return ['☀️ 発表中の警報・注意報はありません'];
    return [`⚠️ 発表中: ${[...active].join('・')}`];
  } catch (e: unknown) {
    return [`⚠️ 気象警報の取得失敗（${e instanceof Error ? e.message : String(e)}）`];
  }
}

export async function buildDisasterBlock(opts: { jmaAreaCode: string; earthquakeMinScale: number }): Promise<SectionBlock> {
  const lines: string[] = [];

  if (opts.jmaAreaCode) {
    lines.push(...await warningLines(opts.jmaAreaCode));
  }

  const eq = await earthquakeLine(opts.earthquakeMinScale);
  if (eq) {
    lines.push(eq);
  } else if (!opts.jmaAreaCode) {
    // 警報セクションも無く地震も無いなら、 何も無いことを 1 行で示す。
    lines.push(`直近${EQ_RECENT_HOURS}時間に震度${scaleLabel(opts.earthquakeMinScale)}以上の地震はありません`);
  }

  return { key: 'disaster', heading: HEADING, lines };
}
