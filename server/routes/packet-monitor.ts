// /api/packet-monitor/* — ローカル PacketMonitor (tools/PacketMonitor) の
// アダプタ別 raw.tsv を読み、 outbound / inbound のサマリを返す。
//
// PacketMonitor 本体は別リポ外ツール (E:\Document\Ars\PacketMonitor) で、
// tshark がアダプタごとに raw.tsv を append し続けている。 Memoria は
// その TSV を「読むだけ」 — capture も逆引きも DB 保存もしない (= 個人
// データ非保管ルールの中で、 ローカル一時ファイルだけを参照)。
//
//   GET /api/packet-monitor/summary?since_minutes=5&top_n=20
//     アダプタごとに outbound (process が出している接続 + SNI/HTTP host
//     /DNS query) と inbound (受け取った接続元 IP + 逆引き) を返す。
//
// 環境変数:
//   MEMORIA_PACKETMON_LOG_ROOT … logs root の override (既定:
//     %USERPROFILE%\Document\Ars\PacketMonitor\logs と
//     E:\Document\Ars\PacketMonitor\logs を順に探す)

import { Hono, type Context } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as dns from 'node:dns/promises';

interface Meta {
  Friendly: string;
  Alias: string;
  Index: number;
  LocalIps: string[];
}

interface OutboundEntry {
  proto: string;
  remote_ip: string;
  remote_port: string;
  hint: string;          // TLS SNI / HTTP Host / DNS query 名 のいずれか
  count: number;
}
interface InboundEntry {
  proto: string;
  remote_ip: string;
  remote_port: string;
  remote_name: string;   // PTR (best-effort)
  count: number;
}

interface AdapterSummary {
  adapter: string;
  alias: string;
  local_ips: string[];
  packet_counts: {
    outbound: number;
    inbound: number;
    self_loop: number;
    off_adapter: number;
  };
  outbound: OutboundEntry[];
  inbound: InboundEntry[];
  // 接続先に渡しているホスト名 (SNI/HTTP host/DNS query) 統合 top
  outbound_hints: Array<{ hint: string; count: number }>;
}

interface PacketMonitorSummary {
  log_root: string | null;
  available: boolean;
  reason: string | null;
  adapters: AdapterSummary[];
  generated_at: string;
}

/** PacketMonitor の logs root を解決する。 env > 標準パス候補の順。 */
function resolveLogRoot(): string | null {
  const env = process.env.MEMORIA_PACKETMON_LOG_ROOT;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    'E:\\Document\\Ars\\PacketMonitor\\logs',
    path.join(os.homedir(), 'Document', 'Ars', 'PacketMonitor', 'logs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 1 アダプタ分の raw.tsv を読んで集計する。 */
async function summarizeAdapter(
  dirPath: string,
  meta: Meta,
  sinceEpoch: number,
  topN: number,
  resolvePtr: boolean,
  ptrCache: Map<string, string>,
): Promise<AdapterSummary> {
  const rawPath = path.join(dirPath, 'raw.tsv');
  const out: AdapterSummary = {
    adapter: meta.Friendly,
    alias: meta.Alias,
    local_ips: meta.LocalIps || [],
    packet_counts: { outbound: 0, inbound: 0, self_loop: 0, off_adapter: 0 },
    outbound: [],
    inbound: [],
    outbound_hints: [],
  };
  if (!fs.existsSync(rawPath)) return out;

  const localSet = new Set(out.local_ips);
  // key="proto|ip:port|hint" → count
  const outboundByDst = new Map<string, number>();
  const outboundByHint = new Map<string, number>();
  const inboundBySrc = new Map<string, number>();

  // 共有書き込み中の TSV を読むので fd を read-only で開く。
  const fd = fs.openSync(rawPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    // 件数の暴走を避けるため、 末尾 32 MiB だけを読む (= 大型 raw.tsv でも応答時間を保つ)。
    const MAX_READ_BYTES = 32 * 1024 * 1024;
    const start = Math.max(0, stat.size - MAX_READ_BYTES);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);

    // start > 0 のとき先頭は途中行になりうるので 1 行目は捨てる。
    const startIdx = start === 0 ? 1 : 1; // 0 起点でもヘッダがあるので 1 行目を必ず捨てる
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const f = line.split('\t');
      if (f.length < 11) continue;
      const ts = f[0];
      const proto = f[1];
      const src = f[2];
      const dst = f[3];
      const tsp = f[4];
      const tdp = f[5];
      const usp = f[6];
      const udp = f[7];
      const sni = f[8];
      const hHost = f[9];
      const dnsQ = f[10];

      if (sinceEpoch > 0 && ts) {
        const tsNum = Number(ts);
        if (Number.isFinite(tsNum) && Math.floor(tsNum) < sinceEpoch) continue;
      }

      const srcLocal = !!src && localSet.has(src);
      const dstLocal = !!dst && localSet.has(dst);
      if (srcLocal && dstLocal) { out.packet_counts.self_loop++; continue; }

      const hint = sni || hHost || dnsQ || '';
      if (srcLocal) {
        const port = tdp || udp || '';
        const key = `${proto}|${dst}:${port}|${hint}`;
        outboundByDst.set(key, (outboundByDst.get(key) || 0) + 1);
        if (hint) outboundByHint.set(hint, (outboundByHint.get(hint) || 0) + 1);
        out.packet_counts.outbound++;
      } else if (dstLocal) {
        const port = tsp || usp || '';
        const key = `${proto}|${src}:${port}`;
        inboundBySrc.set(key, (inboundBySrc.get(key) || 0) + 1);
        out.packet_counts.inbound++;
      } else {
        out.packet_counts.off_adapter++;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // outbound top N
  const outboundEntries = [...outboundByDst.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  out.outbound = outboundEntries.map(([key, count]) => {
    const [proto, hp, hint] = splitN(key, '|', 3);
    const [remote_ip, remote_port] = splitN(hp, ':', 2);
    return { proto, remote_ip, remote_port, hint, count };
  });

  // outbound hint top N
  out.outbound_hints = [...outboundByHint.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([hint, count]) => ({ hint, count }));

  // inbound top N + PTR
  const inboundEntries = [...inboundBySrc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  out.inbound = await Promise.all(inboundEntries.map(async ([key, count]) => {
    const [proto, hp] = splitN(key, '|', 2);
    const [remote_ip, remote_port] = splitN(hp, ':', 2);
    let remote_name = '';
    if (resolvePtr && remote_ip) {
      remote_name = await lookupPtr(remote_ip, ptrCache);
    }
    return { proto, remote_ip, remote_port, remote_name, count };
  }));

  return out;
}

function splitN(s: string, sep: string, n: number): string[] {
  if (n <= 1) return [s];
  const out: string[] = [];
  let cur = s;
  for (let i = 0; i < n - 1; i++) {
    const idx = cur.indexOf(sep);
    if (idx < 0) { out.push(cur); cur = ''; break; }
    out.push(cur.substring(0, idx));
    cur = cur.substring(idx + sep.length);
  }
  if (cur || out.length < n) out.push(cur);
  return out;
}

async function lookupPtr(ip: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(ip)) return cache.get(ip) || '';
  // 短い timeout で best-effort (= UI 応答性を優先)
  try {
    const r = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('ptr-timeout')), 350)),
    ]);
    const name = Array.isArray(r) && r.length > 0 ? r[0] : '';
    cache.set(ip, name);
    return name;
  } catch {
    cache.set(ip, '');
    return '';
  }
}

export function makePacketMonitorRouter(): Hono {
  const r = new Hono();
  // PTR キャッシュは process 寿命だけ保持 (= ローカル名前の変更頻度を考えれば十分)。
  const ptrCache = new Map<string, string>();

  r.get('/api/packet-monitor/summary', async (c: Context) => {
    const logRoot = resolveLogRoot();
    if (!logRoot) {
      return c.json({
        log_root: null,
        available: false,
        reason: 'PacketMonitor logs ディレクトリが見つかりません (E:\\Document\\Ars\\PacketMonitor\\logs 等)',
        adapters: [],
        generated_at: new Date().toISOString(),
      } satisfies PacketMonitorSummary);
    }

    const sinceMin = Math.max(0, Number(c.req.query('since_minutes')) || 0);
    const topN = Math.min(200, Math.max(1, Number(c.req.query('top_n')) || 20));
    const resolvePtr = (c.req.query('resolve_ptr') ?? '1') !== '0';
    const sinceEpoch = sinceMin > 0 ? Math.floor(Date.now() / 1000) - sinceMin * 60 : 0;

    // サブディレクトリ列挙 (= 各アダプタ)
    const subdirs = fs.readdirSync(logRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const adapters: AdapterSummary[] = [];
    for (const d of subdirs) {
      const adapterDir = path.join(logRoot, d.name);
      const metaPath = path.join(adapterDir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      let meta: Meta;
      try {
        // PS 5.1 の `Out-File -Encoding utf8` は BOM を付けるので剥がす。
        const raw = fs.readFileSync(metaPath, 'utf8').replace(/^﻿/, '');
        meta = JSON.parse(raw) as Meta;
      } catch {
        continue;
      }
      const summary = await summarizeAdapter(
        adapterDir, meta, sinceEpoch, topN, resolvePtr, ptrCache,
      );
      adapters.push(summary);
    }

    // パケット数が多い順にソート
    adapters.sort((a, b) =>
      (b.packet_counts.outbound + b.packet_counts.inbound) -
      (a.packet_counts.outbound + a.packet_counts.inbound));

    return c.json({
      log_root: logRoot,
      available: true,
      reason: null,
      adapters,
      generated_at: new Date().toISOString(),
    } satisfies PacketMonitorSummary);
  });

  return r;
}
