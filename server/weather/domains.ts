// 天気を「成長型ブラックボックス」 の判断ドメインに束ねる。
//
//   weather.will_rain    — アンサンブルから「本当に雨か」 を判定 (最初は LLM)
//   weather.likely_place — 曜日から「行きがちな場所」 を推定 (最初は LLM)
//
// LLM フォールバックは runLlm を包んで注入する。 LLM は判断に加えて、
// 「論理化可能なら」 Condition 形式のルール候補 (proposedRule) を返す。
// → 人間 OK でルールが有効化され、 やがて LLM 無しで動く (= 成長)。

import type { BlackBoxEngine, FeatureMap, LlmJudgement } from '../blackbox/index.js';
import { validateCondition } from '../blackbox/index.js';
import { runLlm } from '../llm.js';
import type { EnsembleHour } from './ensemble.js';
import { rainOnset } from './ensemble.js';

export const DOMAIN_WILL_RAIN = 'weather.will_rain';
export const DOMAIN_LIKELY_PLACE = 'weather.likely_place';

// ── 共有: LLM 応答 JSON の頑健パース ──────────────────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return null; }
}

function parseProposedRule(raw: unknown, output: unknown): LlmJudgement['proposedRule'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  try {
    const when = validateCondition(r.when);
    return {
      description: typeof r.description === 'string' ? r.description : 'LLM 提案ルール',
      when,
      output: r.output ?? output,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.7,
      enabled: false,
    };
  } catch { return undefined; }
}

// ── weather.will_rain ──────────────────────────────────────────────────────

export interface WillRainInput {
  place: string;
  date: string;
  hours: EnsembleHour[];
}
export interface WillRainOutput { willRain: boolean; }

/** アンサンブルから will_rain 判断の特徴量を抽出。 ルールはこの map だけを見る。 */
export function willRainFeatures(hours: EnsembleHour[], month: number): FeatureMap {
  let peakAgreement = 0, peakPop = 0, maxPrecip = 0, sources = 0;
  for (const h of hours) {
    if (h.agreement > peakAgreement) peakAgreement = h.agreement;
    if ((h.avgPop ?? 0) > peakPop) peakPop = h.avgPop ?? 0;
    if ((h.maxPrecipMm ?? 0) > maxPrecip) maxPrecip = h.maxPrecipMm ?? 0;
    if (h.votesTotal > sources) sources = h.votesTotal;
  }
  return {
    peakAgreement: Math.round(peakAgreement * 100) / 100,
    peakPop: Math.round(peakPop),
    maxPrecipMm: Math.round(maxPrecip * 10) / 10,
    sources,
    month,
  };
}

function summarizeHoursForPrompt(hours: EnsembleHour[]): string {
  return hours.slice(0, 18).map((h) =>
    `${h.hour.slice(11, 16)} 雨${h.votesRain}/${h.votesTotal} (一致${Math.round(h.agreement * 100)}%, pop ${h.avgPop ?? '-'}%, ${h.maxPrecipMm ?? 0}mm)`,
  ).join('\n');
}

/** runLlm を包んだ will_rain の LLM フォールバック。 */
async function willRainLlm(input: WillRainInput, features: FeatureMap): Promise<LlmJudgement<WillRainOutput>> {
  const prompt = `あなたは天気予報を複数ソースで検証するアシスタントです。
場所「${input.place}」の${input.date}について、 複数の独立した予報サイトを時刻別に突き合わせた結果です。

時刻別アンサンブル (雨と言ったソース数/全ソース数):
${summarizeHoursForPrompt(input.hours)}

特徴量: ${JSON.stringify(features)}

「今日この場所で本当に雨が降るか」 を、 単一サイトの予報ではなく一致度で判定してください。
さらに、 この判定が単純な閾値ルールで再現できるなら proposedRule に Condition を書いてください
(feature 名: peakAgreement, peakPop, maxPrecipMm, sources, month)。

次の JSON だけを返してください:
{"willRain": true/false, "confidence": 0.0-1.0, "rationale": "理由(日本語)",
 "proposedRule": {"description":"...","when":{"op":"cmp","feature":"peakAgreement","cmp":">=","value":0.6},"output":{"willRain":true},"confidence":0.8}}
proposedRule は自信が無ければ省略可。`;

  let willRain = (features.peakAgreement as number) >= 0.5;   // LLM 失敗時の保険
  let confidence = 0.5;
  let rationale = 'LLM 応答が得られず一致率で暫定判定';
  let proposed: LlmJudgement['proposedRule'];
  try {
    const text = await runLlm({ task: 'weather_rain_verify', prompt, timeoutMs: 60_000 });
    const j = extractJson(text);
    if (j) {
      if (typeof j.willRain === 'boolean') willRain = j.willRain;
      if (typeof j.confidence === 'number') confidence = j.confidence;
      if (typeof j.rationale === 'string') rationale = j.rationale;
      proposed = parseProposedRule(j.proposedRule, { willRain });
    }
  } catch { /* 保険値を使う */ }
  return { output: { willRain }, confidence, rationale, proposedRule: proposed };
}

export interface WillRainResult {
  willRain: boolean;
  onsetHour: string | null;
  source: 'rule' | 'llm';
  status: 'auto' | 'pending_review';
  rationale: string;
  decisionId: number;
}

/** 1 地点の will_rain を blackbox で判定し、 雨なら降り始め時刻も返す。 */
export async function decideWillRain(
  engine: BlackBoxEngine, input: WillRainInput, threshold: number, month: number,
): Promise<WillRainResult> {
  const features = willRainFeatures(input.hours, month);
  const { decision, decisionId } = await engine.decide<WillRainInput, WillRainOutput>(
    DOMAIN_WILL_RAIN, input, features, willRainLlm,
  );
  const willRain = decision.output.willRain;
  const onset = willRain ? (rainOnset(input.hours, threshold) ?? rainOnset(input.hours, 0.01)) : null;
  return {
    willRain,
    onsetHour: onset?.hour ?? null,
    source: decision.source,
    status: decision.status,
    rationale: decision.rationale,
    decisionId,
  };
}

// ── weather.likely_place ───────────────────────────────────────────────────

export interface PlaceStat { name: string; lat: number; lon: number; visitsThisDow: number; }
export interface LikelyPlaceInput { dow: number; dowName: string; candidates: PlaceStat[]; }
export interface LikelyPlaceOutput { names: string[]; }

export function likelyPlaceFeatures(input: LikelyPlaceInput): FeatureMap {
  const top = [...input.candidates].sort((a, b) => b.visitsThisDow - a.visitsThisDow)[0];
  return {
    dow: input.dow,
    topPlace: top?.name ?? '',
    topVisits: top?.visitsThisDow ?? 0,
    candidateCount: input.candidates.length,
  };
}

async function likelyPlaceLlm(input: LikelyPlaceInput, _features: FeatureMap): Promise<LlmJudgement<LikelyPlaceOutput>> {
  const list = input.candidates
    .map((c) => `${c.name}: ${input.dowName}曜の訪問 ${c.visitsThisDow} 回`)
    .join('\n');
  const prompt = `登録済みの場所と、 曜日別の過去の訪問回数です。
対象曜日: ${input.dowName}曜
${list || '(履歴なし)'}

この曜日に「行く可能性が高い場所」 を 0〜3 件選んでください。 履歴が薄ければ空配列で構いません。
ルール化できるなら proposedRule に Condition を書いてください (feature: dow, topPlace, topVisits)。

次の JSON だけを返してください:
{"names": ["場所名"], "confidence": 0.0-1.0, "rationale": "理由",
 "proposedRule": {"description":"火曜は学校","when":{"op":"cmp","feature":"dow","cmp":"==","value":2},"output":{"names":["学校"]},"confidence":0.8}}`;

  // 保険: 最多訪問の場所を 1 件。
  const top = [...input.candidates].sort((a, b) => b.visitsThisDow - a.visitsThisDow)[0];
  let names: string[] = top && top.visitsThisDow > 0 ? [top.name] : [];
  let confidence = 0.4;
  let rationale = 'LLM 応答なし、 最多訪問地で暫定';
  let proposed: LlmJudgement['proposedRule'];
  try {
    const text = await runLlm({ task: 'weather_likely_place', prompt, timeoutMs: 60_000 });
    const j = extractJson(text);
    if (j) {
      if (Array.isArray(j.names)) names = j.names.filter((x): x is string => typeof x === 'string');
      if (typeof j.confidence === 'number') confidence = j.confidence;
      if (typeof j.rationale === 'string') rationale = j.rationale;
      proposed = parseProposedRule(j.proposedRule, { names });
    }
  } catch { /* 保険値 */ }
  return { output: { names }, confidence, rationale, proposedRule: proposed };
}

export interface LikelyPlaceResult {
  names: string[];
  source: 'rule' | 'llm';
  status: 'auto' | 'pending_review';
  rationale: string;
  decisionId: number;
}

export async function decideLikelyPlaces(
  engine: BlackBoxEngine, input: LikelyPlaceInput,
): Promise<LikelyPlaceResult> {
  const features = likelyPlaceFeatures(input);
  const { decision, decisionId } = await engine.decide<LikelyPlaceInput, LikelyPlaceOutput>(
    DOMAIN_LIKELY_PLACE, input, features, likelyPlaceLlm,
  );
  return {
    names: decision.output.names,
    source: decision.source,
    status: decision.status,
    rationale: decision.rationale,
    decisionId,
  };
}
