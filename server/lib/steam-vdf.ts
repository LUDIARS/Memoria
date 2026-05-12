// Steam の VDF (Valve's KeyValue) ファイルから「最近プレイした game」 を取る。
// Steam Web API key 無しで動かしたい場合のフォールバック経路。
//
// 読みに行くファイル:
//   <steam>/userdata/<id3>/config/localconfig.vdf    — appid 別の Playtime / LastPlayed
//   <steam>/steamapps/appmanifest_<appid>.acf        — 各 game の name
//
// Steam ディレクトリの推定:
//   1. MEMORIA_STEAM_DIR 環境変数があればそれを使う
//   2. Windows: %PROGRAMFILES(X86)%\Steam → C:\Program Files (x86)\Steam → 32 bit %PROGRAMFILES%\Steam
//   3. macOS  : ~/Library/Application Support/Steam
//   4. Linux  : ~/.steam/steam → ~/.local/share/Steam
//
// 同じ PC に複数 Steam アカウントがあれば userdata/* を全部走査して
// playtime をマージ (= ユーザは単一視点で見たい想定)。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SteamGameSnapshot } from './steam-client.js';

export function detectSteamDir(): string | null {
  const env = process.env.MEMORIA_STEAM_DIR;
  if (env && existsSync(env)) return env;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const p86 = process.env['ProgramFiles(x86)'];
    const p64 = process.env.ProgramFiles;
    if (p86) candidates.push(join(p86, 'Steam'));
    if (p64) candidates.push(join(p64, 'Steam'));
    candidates.push('C:\\Program Files (x86)\\Steam');
  } else if (process.platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    candidates.push(join(homedir(), '.steam', 'steam'));
    candidates.push(join(homedir(), '.local', 'share', 'Steam'));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ── 極小 VDF パーサ ────────────────────────────────────────────────────
//
// Steam の VDF は JSON 風だが、 区切り記号がなく値も常に文字列。 ネストは
// `{ ... }`、 各エントリは `"key" "value"` または `"key" { ... }`。
// 改行 / 空白を区切り、 「//」 はラインコメント。 keyとnested object の間に
// 改行があるパターンを許容する。
//
// 戻り値は再帰的に `Record<string, string | Vdf>` (Vdf = 子オブジェクト)。
type Vdf = { [k: string]: string | Vdf };

export function parseVdf(text: string): Vdf {
  // tokenize
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      // quoted string — Steam doesn't typically escape within VDF values
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      tokens.push(s);
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '}') {
      tokens.push(c);
      i++;
      continue;
    }
    // whitespace / control
    i++;
  }
  // parse
  let p = 0;
  function parseObject(): Vdf {
    const obj: Vdf = {};
    while (p < tokens.length) {
      const tok = tokens[p]!;
      if (tok === '}') { p++; return obj; }
      // tok = key
      const key = tok;
      p++;
      const next = tokens[p];
      if (next === '{') {
        p++;
        obj[key] = parseObject();
      } else if (next != null) {
        obj[key] = next;
        p++;
      } else {
        break;
      }
    }
    return obj;
  }
  return parseObject();
}

// ── localconfig.vdf から playtime を抽出 ─────────────────────────────
//
// パス: <steam>/userdata/<id3>/config/localconfig.vdf
// 構造 (要点):
//   "UserLocalConfigStore"
//   {
//     "Software"
//     {
//       "Valve"
//       {
//         "Steam"
//         {
//           "apps"
//           {
//             "<appid>"
//             {
//               "Playtime"      "1234"     // 分
//               "Playtime2wks"  "120"
//               "LastPlayed"    "1715000000"  // epoch sec
//             }
//             ...
//           }
//         }
//       }
//     }
//   }
//
// Steam バージョン / OS によって case は揺れる ("Software" vs "software"、
// "Apps" vs "apps")。 lookup は case-insensitive にする。

function ci<T extends object>(obj: T, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return (obj as Record<string, unknown>)[k];
  }
  return undefined;
}

function navigate(root: Vdf, path: string[]): Vdf | null {
  let cur: unknown = root;
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = ci(cur as Vdf, p);
  }
  return (typeof cur === 'object' && cur !== null) ? (cur as Vdf) : null;
}

interface AppPlaytimeRaw { playtime: number; playtime2wks: number; lastPlayed: number }

function appsFromLocalConfig(vdf: Vdf): Map<number, AppPlaytimeRaw> {
  const apps = navigate(vdf, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'])
    ?? navigate(vdf, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'Apps']);
  const result = new Map<number, AppPlaytimeRaw>();
  if (!apps) return result;
  for (const [appidStr, node] of Object.entries(apps)) {
    const appid = Number(appidStr);
    if (!Number.isFinite(appid)) continue;
    if (typeof node !== 'object' || node === null) continue;
    const playtime = Number(ci(node, 'Playtime') ?? 0);
    const playtime2wks = Number(ci(node, 'Playtime2wks') ?? 0);
    const lastPlayed = Number(ci(node, 'LastPlayed') ?? 0);
    if (!playtime && !playtime2wks && !lastPlayed) continue;
    result.set(appid, {
      playtime: Number.isFinite(playtime) ? playtime : 0,
      playtime2wks: Number.isFinite(playtime2wks) ? playtime2wks : 0,
      lastPlayed: Number.isFinite(lastPlayed) ? lastPlayed : 0,
    });
  }
  return result;
}

// ── appmanifest_<appid>.acf から name を取る ───────────────────────────
function appIdToName(steamDir: string): Map<number, string> {
  const out = new Map<number, string>();
  const dir = join(steamDir, 'steamapps');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^appmanifest_(\d+)\.acf$/i.exec(f);
    if (!m) continue;
    const appid = Number(m[1]);
    if (!Number.isFinite(appid)) continue;
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      const vdf = parseVdf(text);
      const state = ci(vdf, 'AppState');
      if (state && typeof state === 'object') {
        const name = ci(state as Vdf, 'name');
        if (typeof name === 'string') out.set(appid, name);
      }
    } catch { /* corrupt or unreadable, skip */ }
  }
  return out;
}

// ── 公開関数 ──────────────────────────────────────────────────────────
//
// 戻り値は Web API と同じ形 (SteamGameSnapshot[]) で揃えてある。
// playtime_2weeks_min === 0 のものは UI で「最近未プレイ」 扱いなのでフィルタ
// せずに全部返す (= 集計側で判断)。

export interface VdfRecentResult {
  ok: boolean;
  source: 'vdf';
  steamDir?: string;
  reason?: string;
  games: SteamGameSnapshot[];
}

export function getRecentlyPlayedFromVdf(): VdfRecentResult {
  const steamDir = detectSteamDir();
  if (!steamDir) {
    return { ok: false, source: 'vdf', reason: 'Steam directory not found', games: [] };
  }
  const userdataDir = join(steamDir, 'userdata');
  if (!existsSync(userdataDir)) {
    return { ok: false, source: 'vdf', steamDir, reason: 'userdata directory not found', games: [] };
  }
  const accounts: string[] = [];
  try {
    for (const f of readdirSync(userdataDir)) {
      if (/^\d+$/.test(f)) accounts.push(f);
    }
  } catch {
    return { ok: false, source: 'vdf', steamDir, reason: 'cannot list userdata', games: [] };
  }
  if (accounts.length === 0) {
    return { ok: false, source: 'vdf', steamDir, reason: 'no Steam accounts found', games: [] };
  }

  const nameMap = appIdToName(steamDir);
  const merged = new Map<number, AppPlaytimeRaw>();
  for (const acc of accounts) {
    const cfg = join(userdataDir, acc, 'config', 'localconfig.vdf');
    if (!existsSync(cfg)) continue;
    try {
      const text = readFileSync(cfg, 'utf8');
      const vdf = parseVdf(text);
      const apps = appsFromLocalConfig(vdf);
      for (const [appid, raw] of apps) {
        const prev = merged.get(appid);
        if (!prev) {
          merged.set(appid, { ...raw });
        } else {
          // 複数アカウントでマージ — 各値は max を取る (= 同一 PC 内最大の値)
          merged.set(appid, {
            playtime: Math.max(prev.playtime, raw.playtime),
            playtime2wks: Math.max(prev.playtime2wks, raw.playtime2wks),
            lastPlayed: Math.max(prev.lastPlayed, raw.lastPlayed),
          });
        }
      }
    } catch { /* corrupted vdf — skip */ }
  }

  const games: SteamGameSnapshot[] = [];
  for (const [appid, raw] of merged) {
    if (raw.playtime === 0 && raw.lastPlayed === 0) continue; // 未プレイ
    games.push({
      appid,
      name: nameMap.get(appid) ?? `appid:${appid}`,
      playtime_2weeks_min: raw.playtime2wks || null,
      playtime_forever_min: raw.playtime || null,
      img_icon_url: null,
    });
  }
  // 最近プレイ順に並べる (lastPlayed が無いものは末尾)
  games.sort((a, b) => {
    const la = merged.get(a.appid)?.lastPlayed ?? 0;
    const lb = merged.get(b.appid)?.lastPlayed ?? 0;
    return lb - la;
  });
  return { ok: true, source: 'vdf', steamDir, games };
}
