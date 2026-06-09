// 朝の雨ブリーフィング。 対象地点ごとに全ソース取得 → アンサンブル →
// weather.will_rain で検証し、 通知メッセージを組み立てる。 送信判断は scheduler。

import type BetterSqlite3 from 'better-sqlite3';
import type { BlackBoxEngine } from '../blackbox/index.js';
import { getWeatherConfig } from './config.js';
import { hoursForDay, type EnsembleHour } from './ensemble.js';
import { runAndStoreEnsemble } from './ensemble-service.js';
import { resolveTargets, type TargetPlace } from './targets.js';
import { decideWillRain } from './domains.js';

type Db = BetterSqlite3.Database;

export interface BriefingEntry {
  place: string;
  kind: TargetPlace['kind'];
  willRain: boolean;
  onsetHour: string | null;            // "YYYY-MM-DDTHH:00"
  votesAtOnset: { rain: number; total: number } | null;
  popAtOnset: number | null;
  source: 'rule' | 'llm';
  status: 'auto' | 'pending_review';
  rationale: string;
  decisionId: number;
  sourcesUsed: number;
  sourcesFailed: number;
}

export interface Briefing {
  date: string;
  entries: BriefingEntry[];
  anyRain: boolean;
  anyPending: boolean;
}

function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function onsetVotes(hours: EnsembleHour[], onsetHour: string | null): EnsembleHour | null {
  if (!onsetHour) return null;
  return hours.find((h) => h.hour === onsetHour) ?? null;
}

/** ブリーフィングを生成する (送信はしない)。 */
export async function buildBriefing(db: Db, engine: BlackBoxEngine, now = new Date()): Promise<Briefing> {
  const cfg = getWeatherConfig(db);
  const date = localDate(now);
  const month = now.getMonth() + 1;
  const targets = await resolveTargets(db, engine, now);

  const entries: BriefingEntry[] = [];
  for (const t of targets) {
    const ens = await runAndStoreEnsemble(db, t.lat, t.lon, t.name, now);
    const sourcesUsed = ens.sources.filter((s) => s.ok).length;
    const sourcesFailed = ens.sources.length - sourcesUsed;
    const today = hoursForDay(ens.hours, date, now);

    const verdict = await decideWillRain(
      engine, { place: t.name, date, hours: today }, cfg.agreementThreshold, month,
    );
    const onsetH = onsetVotes(today, verdict.onsetHour);
    entries.push({
      place: t.name,
      kind: t.kind,
      willRain: verdict.willRain,
      onsetHour: verdict.onsetHour,
      votesAtOnset: onsetH ? { rain: onsetH.votesRain, total: onsetH.votesTotal } : null,
      popAtOnset: onsetH?.avgPop ?? null,
      source: verdict.source,
      status: verdict.status,
      rationale: verdict.rationale,
      decisionId: verdict.decisionId,
      sourcesUsed,
      sourcesFailed,
    });
  }

  return {
    date,
    entries,
    anyRain: entries.some((e) => e.willRain),
    anyPending: entries.some((e) => e.status === 'pending_review'),
  };
}

function hourLabel(onsetHour: string | null): string {
  if (!onsetHour) return '日中';
  const hh = Number(onsetHour.slice(11, 13));
  return Number.isFinite(hh) ? `${hh}時頃` : '日中';
}

/** ブリーフィングを push 通知の {title, body} に整形。 雨ゼロは null。 */
export function formatBriefingPush(b: Briefing, notifyWhenClear: boolean): { title: string; body: string } | null {
  const rainy = b.entries.filter((e) => e.willRain);
  if (rainy.length === 0) {
    if (!notifyWhenClear) return null;
    return { title: '☀️ 今日は雨の心配なし', body: b.entries.map((e) => e.place).join(' / ') + ' とも降水予報なし' };
  }

  const lines = rainy.map((e) => {
    const votes = e.votesAtOnset ? `${e.votesAtOnset.rain}/${e.votesAtOnset.total}ソース一致` : '';
    const pop = e.popAtOnset != null ? `降水確率${e.popAtOnset}%` : '';
    const meta = [votes, pop].filter(Boolean).join(' / ');
    const prov = e.source === 'rule'
      ? (e.status === 'pending_review' ? ' [ルール判定/OK・NG待ち]' : ' [ルール判定]')
      : ' [AI判定]';
    return `[${e.place}] ${hourLabel(e.onsetHour)}から雨${meta ? ` (${meta})` : ''}${prov}`;
  });

  const title = `☔ 今日 ${rainy.map((e) => e.place).join('・')} で雨の予報`;
  return { title, body: lines.join('\n') };
}
