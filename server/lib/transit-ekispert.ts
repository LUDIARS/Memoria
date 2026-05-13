// Ekispert Web Service v1 (https://docs.ekispert.com/v1/api/) クライアント。
// JR + 私鉄 + バス 横断の経路 / 駅検索 / 始発・終電を扱う。 free tier は
// 50 req/day 制限なので、 内部 cache (5 分) を入れて UI のチラつきで枯渇
// しないようにする。 遅延情報は Ekispert 単体では (premium) 限定なので、
// このクライアントは route/station/first-last だけを取り扱う。
//
// 認証: query 文字列に `key=<API_KEY>` を毎回付与。 API key は app_settings の
// `transit.ekispert_api_key` から取る。

const BASE = 'https://api.ekispert.jp/v1/json';
const FETCH_TIMEOUT_MS = 15_000;

export interface EkispertConfig {
  apiKey: string;
}

// ── 共通 fetch ────────────────────────────────────────────────────────────

interface QueryParams { [key: string]: string | number | undefined }

async function call<T>(cfg: EkispertConfig, path: string, params: QueryParams): Promise<T> {
  if (!cfg.apiKey) throw new Error('ekispert_api_key 未設定 (設定 → 交通から登録)');
  const qs = new URLSearchParams({ key: cfg.apiKey });
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    qs.set(k, String(v));
  }
  const url = `${BASE}${path}?${qs.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ekispert ${path}: ${res.status} ${res.statusText}`);
  const body = await res.json() as { ResultSet?: T; Error?: { Message?: string } };
  if (body.Error) throw new Error(`ekispert: ${body.Error.Message ?? 'API error'}`);
  if (!body.ResultSet) throw new Error('ekispert: ResultSet 無し');
  return body.ResultSet;
}

// ── /station (= 駅名検索) ────────────────────────────────────────────────

interface RawStationPoint {
  Station?: RawStation;
  Prefecture?: { Name?: string };
}
interface RawStation {
  code: string;
  Name: string;
  Yomi?: string;
  Type?: string;
  Prefecture?: { Name?: string; code?: string };
}

export interface Station {
  code: string;
  name: string;
  yomi?: string;
  type?: string;
  prefecture?: string;
}

/** 駅名で検索。 部分一致。 上位 30 件を返す。 */
export async function searchStations(cfg: EkispertConfig, name: string): Promise<Station[]> {
  if (!name.trim()) return [];
  const rs = await call<{ Point?: RawStationPoint | RawStationPoint[] }>(cfg, '/station', { name: name.trim() });
  const arr = Array.isArray(rs.Point) ? rs.Point : rs.Point ? [rs.Point] : [];
  return arr
    .filter((p) => !!p.Station)
    .map((p) => {
      const s = p.Station!;
      return {
        code: s.code,
        name: s.Name,
        yomi: s.Yomi,
        type: s.Type,
        prefecture: p.Prefecture?.Name ?? s.Prefecture?.Name,
      };
    });
}

// ── /search/course/light (= 経路検索) ─────────────────────────────────────

export type SearchType =
  | 'plain'       // 標準 (出発時刻)
  | 'departure'   // 出発時刻
  | 'arrival'     // 到着時刻
  | 'firstTrain'  // 始発
  | 'lastTrain';  // 終電

export interface SearchInput {
  /** Station code (= Station.code from searchStations) を 2 つ以上、 viaList で連結する。 */
  viaCodes: string[];
  date?: string;              // YYYYMMDD
  time?: string;              // HHMM
  searchType?: SearchType;
  /** 1 ページの最大 course 数 (= ekispert default 5)。 */
  resultCount?: number;
}

export interface SearchCourse {
  /** 全体所要時間 (分)。 */
  duration_min: number;
  /** 全運賃の合計 (円、 IC/紙の lower)。 */
  fare_yen: number;
  /** 各区間: 駅 → 駅 + 路線名 + 時刻。 */
  segments: SearchSegment[];
  /** 乗換回数 */
  transfer_count: number;
}

export interface SearchSegment {
  /** 路線名 (例 "JR山手線" "メトロ千代田線") */
  line: string;
  /** 路線会社 (例 "JR東日本") */
  company?: string;
  from_station: string;
  to_station: string;
  /** ISO 形式 (=ekispert raw "20260514093000" → "2026-05-14T09:30:00") */
  departure_at: string | null;
  arrival_at: string | null;
  /** 「快速」 等の種別 */
  train_type?: string;
}

interface RawCourse {
  TimeOnBoard?: string;       // 分
  TimeOther?: string;
  TimeWalk?: string;
  Price?: RawPriceList;
  TransferCount?: string;
  Route?: RawRoute;
}
interface RawPriceList {
  Price?: RawPriceItem | RawPriceItem[];
}
interface RawPriceItem {
  kind?: string;
  Oneway?: string;
  Type?: string;
}
interface RawRoute {
  Line?: RawLine | RawLine[];
  Point?: RawPointInRoute | RawPointInRoute[];
}
interface RawLine {
  Name: string;
  /** 列車種別 例 "快速" "急行" */
  TypicalName?: string;
  Type?: string;
  Color?: string;
  DepartureState?: { Datetime?: { text?: string } };
  ArrivalState?: { Datetime?: { text?: string } };
  Company?: { Name?: string };
}
interface RawPointInRoute {
  Station?: { Name?: string; code?: string };
  Prefecture?: { Name?: string };
}

function rawDatetimeToIso(t: string | undefined): string | null {
  if (!t) return null;
  // ekispert は "2026-05-14T09:30:00+09:00" 形式または "20260514093000" を返す
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return t;
  if (/^\d{14}$/.test(t)) {
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
  }
  return t;
}

function lowestPrice(price: RawPriceList | undefined): number {
  if (!price?.Price) return 0;
  const arr = Array.isArray(price.Price) ? price.Price : [price.Price];
  // 「片道」 totalfare で kind=Fare (運賃) を採用、 IC があれば IC 優先
  let yen = 0;
  for (const p of arr) {
    const k = p.kind ?? p.Type ?? '';
    if (!/Fare|FareSummary/i.test(k)) continue;
    const v = Number(p.Oneway);
    if (Number.isFinite(v)) {
      if (yen === 0 || v < yen) yen = v;
    }
  }
  return yen;
}

function normalizeCourse(c: RawCourse): SearchCourse {
  const lines = c.Route?.Line
    ? (Array.isArray(c.Route.Line) ? c.Route.Line : [c.Route.Line])
    : [];
  const points = c.Route?.Point
    ? (Array.isArray(c.Route.Point) ? c.Route.Point : [c.Route.Point])
    : [];
  const segments: SearchSegment[] = lines.map((ln, i) => {
    const fromP = points[i]?.Station?.Name ?? '';
    const toP = points[i + 1]?.Station?.Name ?? '';
    return {
      line: ln.Name,
      company: ln.Company?.Name,
      train_type: ln.TypicalName,
      from_station: fromP,
      to_station: toP,
      departure_at: rawDatetimeToIso(ln.DepartureState?.Datetime?.text),
      arrival_at: rawDatetimeToIso(ln.ArrivalState?.Datetime?.text),
    };
  });
  return {
    duration_min: Number(c.TimeOnBoard ?? '0') + Number(c.TimeOther ?? '0') + Number(c.TimeWalk ?? '0'),
    fare_yen: lowestPrice(c.Price),
    transfer_count: Number(c.TransferCount ?? '0'),
    segments,
  };
}

/** 経路検索 (= 「乗換案内」)。 free tier の light を使う。 */
export async function searchRoutes(cfg: EkispertConfig, input: SearchInput): Promise<SearchCourse[]> {
  if (input.viaCodes.length < 2) throw new Error('viaCodes は 2 件以上必要');
  const params: QueryParams = {
    viaList: input.viaCodes.join(':'),
    date: input.date,
    time: input.time,
    searchType: input.searchType ?? 'plain',
    resultCount: input.resultCount ?? 5,
  };
  const rs = await call<{ Course?: RawCourse | RawCourse[] }>(cfg, '/search/course/light', params);
  const arr = rs.Course ? (Array.isArray(rs.Course) ? rs.Course : [rs.Course]) : [];
  return arr.map(normalizeCourse);
}

/** 始発電車検索 (= 「翌朝の最初の電車」)。 内部的には searchRoutes(firstTrain) ラッパ。 */
export function firstTrain(cfg: EkispertConfig, from: string, to: string, date?: string): Promise<SearchCourse[]> {
  return searchRoutes(cfg, { viaCodes: [from, to], date, searchType: 'firstTrain' });
}

/** 終電検索。 */
export function lastTrain(cfg: EkispertConfig, from: string, to: string, date?: string): Promise<SearchCourse[]> {
  return searchRoutes(cfg, { viaCodes: [from, to], date, searchType: 'lastTrain' });
}

// ── /operationLine (= 路線一覧 + 運行情報) ───────────────────────────────
//
// 注意: 遅延 (= 運行情報の文章) を取れるのは 「premium 契約」 のみ。
// free tier では line 名と code のみ返る。 呼び出し側で UI 表示の可否を判定。

interface RawOperationLine {
  Name: string;
  code?: string;
  Status?: { text?: string };
  StatusImage?: { url?: string };
  /** 詳細メッセージ (premium のみ) */
  Description?: { text?: string };
}

export interface OperationLine {
  code: string;
  name: string;
  status: string | null;
  description: string | null;
  status_image: string | null;
}

export async function listOperationLines(cfg: EkispertConfig): Promise<OperationLine[]> {
  const rs = await call<{ Line?: RawOperationLine | RawOperationLine[] }>(cfg, '/operationLine', {});
  const arr = rs.Line ? (Array.isArray(rs.Line) ? rs.Line : [rs.Line]) : [];
  return arr.map((ln) => ({
    code: ln.code ?? '',
    name: ln.Name,
    status: ln.Status?.text ?? null,
    description: ln.Description?.text ?? null,
    status_image: ln.StatusImage?.url ?? null,
  }));
}
