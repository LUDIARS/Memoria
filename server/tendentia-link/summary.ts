// Tendentia (トレンドの集積サービス) の一覧から、 Memoria の AI タブに出す要点だけを取り出す純関数。
// Tendentia の応答は外部サービス由来なので、 形を確かめてから必要な項目だけを写す。

export interface TendentiaHighlight {
  title: string;
  url: string | null;
  sourceName: string;
  rank: number;
  reasons: string[];
}

export interface TendentiaGenreSummary {
  genre: string;
  label: string;
  highlights: TendentiaHighlight[];
}

export interface TendentiaCrossHit {
  title: string;
  sourceNames: string[];
}

export interface TendentiaSummary {
  lastCrawledAt: string | null;
  crossHits: TendentiaCrossHit[];
  genres: TendentiaGenreSummary[];
}

const MAX_CROSS_HITS = 8;
const MAX_TEXT = 300;

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '');
const httpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

function toHighlight(value: unknown): TendentiaHighlight | null {
  if (!isObj(value)) return null;
  const title = text(value.title);
  if (!title) return null;
  return {
    title,
    url: httpUrl(value.url),
    sourceName: text(value.sourceName),
    rank: typeof value.rank === 'number' && Number.isFinite(value.rank) ? value.rank : 0,
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((r): r is string => typeof r === 'string').slice(0, 3) : [],
  };
}

/** Tendentia の GET /api/trend-crawler/overview の `overview` を要点に絞る。 注目の無いジャンルは出さない。 */
export function summarizeOverview(overview: unknown): TendentiaSummary {
  if (!isObj(overview)) throw new Error('Tendentia の応答に overview がありません');
  const genres = Array.isArray(overview.genres) ? overview.genres : [];
  const crossHits = Array.isArray(overview.crossHits) ? overview.crossHits : [];
  return {
    lastCrawledAt: typeof overview.lastCrawledAt === 'string' ? overview.lastCrawledAt : null,
    crossHits: crossHits
      .filter(isObj)
      .map((hit) => ({
        title: text(hit.title),
        sourceNames: (Array.isArray(hit.sources) ? hit.sources : []).filter(isObj).map((s) => text(s.name)).filter(Boolean),
      }))
      .filter((hit) => hit.title)
      .slice(0, MAX_CROSS_HITS),
    genres: genres
      .filter(isObj)
      .map((genre) => ({
        genre: text(genre.genre),
        label: text(genre.label),
        highlights: (Array.isArray(genre.highlights) ? genre.highlights : []).map(toHighlight).filter((h): h is TendentiaHighlight => h !== null),
      }))
      .filter((genre) => genre.genre && genre.highlights.length > 0),
  };
}
