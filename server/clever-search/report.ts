import {
  CLEVER_SEARCH_CATEGORIES,
  CLEVER_SEARCH_CATEGORY_LABELS,
  type CleverSearchCategory,
  type CleverSearchCategoryReport,
  type CleverSearchCitation,
  type CleverSearchHit,
  type CleverSearchReport,
} from './types.js';

const REPRESENTATIVE_LIMIT = 5;
const EXCERPT_RADIUS = 110;

export interface CleverSearchReportOptions {
  now?: () => Date;
  random?: () => number;
  searchElapsedMs: number;
}

function timestampValue(value: string): number {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeExcerpt(hit: CleverSearchHit, normalizedQuery: string): string {
  const raw = `${hit.title}\n${hit.content}`.replace(/\s+/g, ' ').trim();
  if (!raw) return '(本文なし)';
  const haystack = raw.toLocaleLowerCase('ja-JP');
  const terms = normalizedQuery.split(' ').filter(Boolean);
  const positions = terms.map((term) => haystack.indexOf(term)).filter((index) => index >= 0);
  const matchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, matchAt - EXCERPT_RADIUS);
  const end = Math.min(raw.length, matchAt + normalizedQuery.length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
}

function toCitation(hit: CleverSearchHit, normalizedQuery: string): CleverSearchCitation {
  return {
    sourceType: hit.source_type,
    sourceId: hit.source_id,
    sourceSubtype: hit.source_subtype,
    title: hit.title || `${hit.source_type} #${hit.source_id}`,
    occurredAt: hit.occurred_at,
    excerpt: makeExcerpt(hit, normalizedQuery),
    score: hit.score,
  };
}

function reservoirSample<T>(items: T[], limit: number, random: () => number): T[] {
  if (items.length <= limit) return [...items];
  const sample = items.slice(0, limit);
  for (let index = limit; index < items.length; index += 1) {
    const replacement = Math.floor(random() * (index + 1));
    if (replacement < limit) sample[replacement] = items[index];
  }
  return sample;
}

function categorySummary(label: string, citations: CleverSearchCitation[]): string {
  const sourceCounts = new Map<string, number>();
  for (const citation of citations) {
    sourceCounts.set(citation.sourceType, (sourceCounts.get(citation.sourceType) ?? 0) + 1);
  }
  const dominant = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const span = citations.length > 1
    ? `${citations[citations.length - 1].occurredAt} 〜 ${citations[0].occurredAt}`
    : citations[0]?.occurredAt ?? '';
  const dominantText = dominant ? `中心は ${dominant[0]} (${dominant[1]}件)` : '該当なし';
  return `${label}では ${citations.length}件。${dominantText}で、記録期間は ${span}。`;
}

function buildCategory(
  key: CleverSearchCategory,
  sortedHits: CleverSearchHit[],
  normalizedQuery: string,
  random: () => number,
): CleverSearchCategoryReport | null {
  const categoryHits = sortedHits.filter((hit) => hit.report_category === key);
  if (categoryHits.length === 0) return null;

  const citations = categoryHits.map((hit) => toCitation(hit, normalizedQuery));
  const sourceCounts = new Map<string, number>();
  for (const citation of citations) {
    sourceCounts.set(citation.sourceType, (sourceCounts.get(citation.sourceType) ?? 0) + 1);
  }

  return {
    key,
    label: CLEVER_SEARCH_CATEGORY_LABELS[key],
    count: citations.length,
    summary: categorySummary(CLEVER_SEARCH_CATEGORY_LABELS[key], citations),
    firstOccurredAt: citations[citations.length - 1].occurredAt,
    lastOccurredAt: citations[0].occurredAt,
    sourceBreakdown: [...sourceCounts.entries()]
      .map(([sourceType, count]) => ({ sourceType, count }))
      .sort((a, b) => b.count - a.count || a.sourceType.localeCompare(b.sourceType)),
    representatives: reservoirSample(citations, REPRESENTATIVE_LIMIT, random),
    citations,
  };
}

function buildTimeline(hits: CleverSearchHit[]): Array<{ month: string; count: number }> {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const month = /^\d{4}-\d{2}/.exec(hit.occurred_at)?.[0] ?? '日時不明';
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function overallSummary(query: string, categories: CleverSearchCategoryReport[]): string {
  const total = categories.reduce((sum, category) => sum + category.count, 0);
  if (total === 0) return `「${query}」に一致する Memoria の記録は見つかりませんでした。`;
  const dominant = [...categories].sort((a, b) => b.count - a.count)[0];
  const distribution = categories.map((category) => `${category.label} ${category.count}件`).join('、');
  return `「${query}」に関する記録は合計 ${total}件です。最も多いのは${dominant.label}で、内訳は ${distribution}。`;
}

export function buildCleverSearchReport(
  query: string,
  normalizedQuery: string,
  hits: CleverSearchHit[],
  options: CleverSearchReportOptions,
): CleverSearchReport {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const sortedHits = [...hits].sort((a, b) => timestampValue(b.occurred_at) - timestampValue(a.occurred_at));
  const categories = CLEVER_SEARCH_CATEGORIES
    .map((key) => buildCategory(key, sortedHits, normalizedQuery, random))
    .filter((category): category is CleverSearchCategoryReport => category !== null);

  return {
    version: 1,
    query,
    normalizedQuery,
    totalHits: sortedHits.length,
    summary: overallSummary(query, categories),
    firstOccurredAt: sortedHits.at(-1)?.occurred_at ?? null,
    lastOccurredAt: sortedHits[0]?.occurred_at ?? null,
    categories,
    timeline: buildTimeline(sortedHits),
    createdAt: now().toISOString(),
    searchElapsedMs: Math.max(0, Math.round(options.searchElapsedMs)),
  };
}
