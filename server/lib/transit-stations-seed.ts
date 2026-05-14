// HeartRails Express (https://express.heartrails.com/api.html) の駅マスタを
// 起動時に bulk import する。 完全無料 + API key 不要。
//
// API は getStations を prefecture 引数で叩けないので 2 段で取る:
//   1. getLines?prefecture=X   → 路線一覧 (per prefecture)
//   2. getStations?line=Y      → 駅 + lat/lon + prev/next + prefecture
//
// 47 prefectures × ~30 lines / pref = ~1400 line; 重複あり (= 隣接県またぐ路線)
// で dedup 後 ~500 unique。 リクエスト合計 ~550 で 1 req 0.3-0.4s → 約 3-4 分。
// background 実行で startup は阻害しない。 既に行数 > 0 なら skip (idempotent)。
//
// 注意: 同じ駅名でも乗入路線ごとに別エントリが返る (= 「新宿」 が 10+ 行)。
// テーブルは (name, line, prefecture) UNIQUE なので そのまま append OK。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

const HEARTRAILS_URL = 'https://express.heartrails.com/api/json';
const FETCH_TIMEOUT_MS = 10_000;
const REQ_INTERVAL_MS = 400;       // 連続 fetch の間隔。 サーバに優しくする。

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県',
  '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県',
  '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
];

interface HeartrailsStation {
  name: string;
  prev?: string | null;
  next?: string | null;
  line: string;
  x: number;       // longitude
  y: number;       // latitude
  postal?: string;
  prefecture: string;
}

interface HeartrailsStationResponse {
  response?: { station?: HeartrailsStation[]; error?: string };
}

interface HeartrailsLinesResponse {
  response?: { line?: string[]; error?: string };
}

export interface SeedResult {
  imported: number;
  skipped: boolean;       // true = 既存行ありで skip
  errors: number;
}

/** 起動時 1 度呼ぶ。 既に行数 > 0 なら 即 return。 */
export async function seedStationsIfEmpty(db: Db): Promise<SeedResult> {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM stations`).get() as { n: number };
  if (existing.n > 0) return { imported: 0, skipped: true, errors: 0 };

  console.log('[stations] HeartRails Express から駅マスタを取得開始 (~3-4 分、 background)…');
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO stations
       (name, line, prefecture, lat, lon, postal, prev_station, next_station, is_terminal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let imported = 0;
  let errors = 0;

  // Step 1: prefecture ごとに路線リストを取得し、 unique 路線集合を作る
  const allLines = new Set<string>();
  for (const pref of PREFECTURES) {
    try {
      const url = `${HEARTRAILS_URL}?method=getLines&prefecture=${encodeURIComponent(pref)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) { errors++; continue; }
      const j = await res.json() as HeartrailsLinesResponse;
      for (const ln of j.response?.line ?? []) allLines.add(ln);
    } catch (e: unknown) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[stations] getLines ${pref}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, REQ_INTERVAL_MS));
  }
  console.log(`[stations] 路線収集: ${allLines.size} unique line(s)`);

  // Step 2: 各路線で getStations → DB に append
  let i = 0;
  for (const line of allLines) {
    i++;
    try {
      const url = `${HEARTRAILS_URL}?method=getStations&line=${encodeURIComponent(line)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) { errors++; continue; }
      const j = await res.json() as HeartrailsStationResponse;
      const arr = j.response?.station ?? [];
      const tx = db.transaction((rows: HeartrailsStation[]) => {
        for (const s of rows) {
          if (!s.name || !s.line || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
          const isTerminal = (!s.prev || !s.next) ? 1 : 0;
          const info = insertStmt.run(
            s.name, s.line, s.prefecture ?? null,
            s.y, s.x,
            s.postal ?? null,
            s.prev ?? null, s.next ?? null,
            isTerminal,
          );
          imported += info.changes;
        }
      });
      tx(arr);
      if (i % 50 === 0) console.log(`[stations] 進捗: ${i}/${allLines.size} line(s), ${imported} 駅まで取込`);
    } catch (e: unknown) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[stations] getStations line=${line}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, REQ_INTERVAL_MS));
  }

  console.log(`[stations] 取込完了: ${imported} 駅 / errors=${errors}`);
  return { imported, skipped: false, errors };
}

// ── 検索 helper (= /api/transit/stations/local の中身) ─────────────────

export interface StationSearchInput {
  q: string;
  lat?: number;
  lon?: number;
  limit?: number;
}

export interface StationCandidate {
  name: string;
  prefecture: string;
  lines: string[];
  lat: number;
  lon: number;
  is_terminal: boolean;
  /** GPS 与えられたときの直線距離 (m) */
  distance_m?: number;
}

/**
 * クエリ文字列 + 任意 GPS で駅候補を返す。
 *
 * - 駅名前方一致 を最優先、 部分一致を次点に
 * - 同じ (name, prefecture) は 路線複数を集約して 1 候補に
 * - lat/lon があれば Haversine 距離で再 sort (ターミナル駅優先 + 近い順)
 *
 * 同名駅 (= 「白川」 等) は 別 prefecture で別エントリとして返す。
 */
export function searchStationsLocal(db: Db, input: StationSearchInput): StationCandidate[] {
  const q = input.q.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  // 取得は SQL 内で粗く絞って後段で集約 + sort
  // 前方一致を優先する LIKE pattern
  const prefix = `${q}%`;
  const sub = `%${q}%`;
  const rows = db.prepare(
    `SELECT name, line, prefecture, lat, lon, is_terminal,
            CASE WHEN name LIKE ? THEN 0 ELSE 1 END AS match_rank
       FROM stations
      WHERE name LIKE ? OR name LIKE ?
      ORDER BY match_rank ASC, name ASC, prefecture ASC
      LIMIT 300`,
  ).all(prefix, prefix, sub) as Array<{
    name: string; line: string; prefecture: string;
    lat: number; lon: number; is_terminal: number; match_rank: number;
  }>;

  // 集約: (name, prefecture) → lines[]
  const groups = new Map<string, StationCandidate & { _rank: number }>();
  for (const r of rows) {
    const key = `${r.name}|${r.prefecture}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.lines.includes(r.line)) existing.lines.push(r.line);
      if (r.is_terminal) existing.is_terminal = true;
    } else {
      groups.set(key, {
        _rank: r.match_rank,
        name: r.name,
        prefecture: r.prefecture,
        lines: [r.line],
        lat: r.lat, lon: r.lon,
        is_terminal: !!r.is_terminal,
      });
    }
  }
  const candidates = [...groups.values()];

  // GPS 距離計算
  const hasGps = Number.isFinite(input.lat) && Number.isFinite(input.lon);
  if (hasGps) {
    for (const c of candidates) {
      c.distance_m = haversine(c.lat, c.lon, input.lat!, input.lon!);
    }
  }

  // ソート:
  //   match_rank ASC (前方一致を上)
  //   is_terminal DESC (ターミナル駅を上)
  //   distance_m ASC (近い順、 GPS あれば)
  //   name ASC
  candidates.sort((a, b) => {
    if (a._rank !== b._rank) return a._rank - b._rank;
    if (a.is_terminal !== b.is_terminal) return a.is_terminal ? -1 : 1;
    if (hasGps) {
      const da = a.distance_m ?? Number.POSITIVE_INFINITY;
      const db_ = b.distance_m ?? Number.POSITIVE_INFINITY;
      if (da !== db_) return da - db_;
    }
    return a.name.localeCompare(b.name);
  });

  return candidates.slice(0, limit).map(({ _rank: _r, ...rest }) => rest);
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
