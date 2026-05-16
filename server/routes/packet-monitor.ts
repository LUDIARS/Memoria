// /api/packet-monitor/* — ローカル PacketMonitor (tools/PacketMonitor) の
// アダプタ別 raw.tsv を読み、 outbound / inbound のサマリを返す。
//
// PacketMonitor 本体は別リポ外ツール (E:\Document\Ars\PacketMonitor) で、
// tshark がアダプタごとに raw.tsv を append し続けている。 Memoria は
// その TSV を「読むだけ」 — summary 用の DB 保存はしない (= 個人
// データ非保管ルールの中で、 ローカル一時ファイルだけを参照)。
//
//   GET    /api/packet-monitor/summary
//   GET    /api/packet-monitor/registered
//   POST   /api/packet-monitor/registered            { key, note? }
//   DELETE /api/packet-monitor/registered/:key
//   POST   /api/packet-monitor/inspect               { target, adapter?, max_packets?, max_seconds? }
//
// 登録は data dir 内 JSON に永続化する (登録一覧は個人データではなく
// 「自分が確認済の宛先」 メタなので OK)。 inspect (= パケット中身) は
// メモリ内 Map に置き、 summary 取得のたびに丸ごと破棄する。
//
// 環境変数:
//   MEMORIA_PACKETMON_LOG_ROOT … logs root の override

import { Hono, type Context } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { WELL_KNOWN_RULES, lookupFriendlyName } from '../lib/packet-known-endpoints.js';
import { getProcessAttribution } from '../lib/packet-process-attribution.js';
import { runLlm } from '../llm.js';
import type { FifoQueue } from '../queue.js';

interface Meta {
  Friendly: string;
  Alias: string;
  Index: number;
  LocalIps: string[];
}

interface FlowRemote {
  proto: string;
  remote_ip: string;
  remote_port: string;
  count: number;
  /** この remote へ繋いだプロセス名 (Sysmon Event 3 / Get-NetTCPConnection 由来)。
   *  該当プロセスが特定できなかったら空配列。 outbound 側でのみ埋まる */
  processes?: string[];
}
interface OutboundGroup {
  /** 表示キー: SNI/HTTP host/DNS query があればそれ、 無ければ PTR、
   *  PTR も無ければ IP。 同じ key は merge 済 */
  key: string;
  /** key が IP ではなく名前 (= SNI/HTTP/DNS or PTR) なら true */
  is_domain: boolean;
  /** packet から直接取れたヒント (TLS SNI / HTTP Host / DNS query 名)。
   *  PTR 由来の場合は空 */
  hint: string;
  /** 名前を PTR (= 逆引き) から取った場合 true。 UI で 「(PTR)」 表示する */
  derived_from_ptr: boolean;
  /** well-known 辞書でマッチしたサービス名 (= "Anthropic" / "Cloudflare" 等)。
   *  null ならマッチなし。 */
  friendly_name: string | null;
  /** この group 内に集まった (proto, ip, port) のユニーク一覧。 count 降順 */
  remotes: FlowRemote[];
  /** group 内の全 packet 数 */
  total_count: number;
  /** group 内で観測された unique remote IP 数 */
  unique_ips: number;
  /** ユーザが登録済 (= 「確認した」 マークを付けたか)。 */
  registered: boolean;
  /** localhost 系か (= 中身チェック対象外)。 */
  is_localhost: boolean;
  /** この group 全体で観測したプロセス名 + 件数 (= remotes[*].processes の union)。
   *  Sysmon Event 3 / Get-NetTCPConnection から特定できた送信元プロセス。 */
  processes?: Array<{ name: string; count: number }>;
}
interface InboundGroup {
  /** 表示キー: PTR があればそれ、 なければ IP。 PTR 単位で集約済 */
  key: string;
  is_domain: boolean;
  remote_name: string;      // PTR (空なら is_domain=false)
  friendly_name: string | null;
  remotes: FlowRemote[];
  total_count: number;
  unique_ips: number;
  registered: boolean;
  is_localhost: boolean;
}

interface AdapterSummary {
  adapter: string;
  alias: string;
  adapter_index: number;    // tshark -i に渡すアダプタ番号 (inspect で使う)
  local_ips: string[];
  packet_counts: {
    outbound: number;
    inbound: number;
    self_loop: number;
    off_adapter: number;
  };
  /** ドメイン (or IP) 単位で集約済の outbound */
  outbound: OutboundGroup[];
  /** ドメイン (or IP) 単位で集約済の inbound */
  inbound: InboundGroup[];
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

// ── 「登録済」 ドメイン / IP 一覧 ────────────────────────────────────────
//
// 「ユーザが見た上で OK と判断した宛先」 を ここに溜める。 未登録のものは
// UI で 登録 + 中身確認 を促す。 個人データではないので Memoria 本体 DB
// ではなく Memoria の data dir 直下の JSON に永続化する。

interface RegisteredEntry { key: string; note: string; added_at: string }

function localhostCidrs(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('169.254.')) return true;     // APIPA
  if (ip.startsWith('fe80:')) return true;         // IPv6 link-local
  return false;
}

class RegisteredStore {
  private set = new Map<string, RegisteredEntry>();
  private filePath: string | null = null;

  init(dataDir: string | null): void {
    if (!dataDir) return;
    this.filePath = path.join(dataDir, 'packet-monitor-registered.json');
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8').replace(/^﻿/, '');
        const arr = JSON.parse(raw) as RegisteredEntry[];
        for (const e of arr) {
          if (e && typeof e.key === 'string' && e.key) this.set.set(e.key, e);
        }
      } catch (e) {
        console.warn('[packet-monitor] registered load failed:', e);
      }
    }
  }
  list(): RegisteredEntry[] { return [...this.set.values()].sort((a, b) => a.key.localeCompare(b.key)); }
  has(key: string): boolean { return this.set.has(key); }
  add(key: string, note: string): RegisteredEntry {
    const e: RegisteredEntry = { key, note: note || '', added_at: new Date().toISOString() };
    this.set.set(key, e);
    this.persist();
    return e;
  }
  remove(key: string): boolean {
    const ok = this.set.delete(key);
    if (ok) this.persist();
    return ok;
  }
  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.list(), null, 2), 'utf8');
    } catch (e) {
      console.warn('[packet-monitor] registered save failed:', e);
    }
  }
}

// ── 中身 (inspect) キャッシュ ────────────────────────────────────────────
//
// on-demand に tshark を別プロセスで走らせ、 結果を memory に貯める。
// summary が叩かれるたびに丸ごと破棄する (= 「更新に合わせて破棄」)。
interface InspectResult {
  target: string;
  adapter_index: number;
  bpf_filter: string;
  display_filter: string;
  max_packets: number;
  max_seconds: number;
  finished_at: string;
  packets: number;
  text: string;          // tshark の -V 縮約版 (= 最初の N 行)
  error: string | null;
}

const inspectCache = new Map<string, InspectResult>();

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

/** 1 アダプタ分の raw.tsv を読んで集計する。
 *  procByRemote: 「(proto, remote_ip, remote_port) → 観測されたプロセス名 + 件数」
 *  Sysmon / NetTCPConnection から作った map。 outbound group に inline 表示するのに使う */
async function summarizeAdapter(
  dirPath: string,
  meta: Meta,
  sinceEpoch: number,
  topN: number,
  resolvePtr: boolean,
  ptrCache: Map<string, string>,
  registered: RegisteredStore,
  procByRemote: Map<string, Map<string, number>>,
): Promise<AdapterSummary> {
  const rawPath = path.join(dirPath, 'raw.tsv');
  const out: AdapterSummary = {
    adapter: meta.Friendly,
    alias: meta.Alias,
    adapter_index: typeof meta.Index === 'number' ? meta.Index : 0,
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

  // ── outbound: ドメイン (hint) ごとに集約。 同じドメインへ別 IP / ポートで
  //    繋がっていても 1 行にまとめる。
  //    hint が空 (= SNI/HTTP host/DNS query が観測できなかった) IP は、
  //    PTR (逆引き) を引いて、 取れたら PTR をキーに格上げ。 取れない時だけ
  //    IP のままの groupKey になる。 これで「IP のみ」 行も裏にドメインがある
  //    なら同じドメインで merge できる。
  {
    // 1) hint なし IP を集めて並列 PTR 逆引き
    const ipsForPtr = new Set<string>();
    for (const key of outboundByDst.keys()) {
      const [, hp, hint] = splitN(key, '|', 3);
      if (hint) continue;
      const [ip] = splitN(hp, ':', 2);
      if (ip && !localhostCidrs(ip)) ipsForPtr.add(ip);
    }
    const outboundPtr = new Map<string, string>();
    if (resolvePtr && ipsForPtr.size > 0) {
      await Promise.all([...ipsForPtr].map(async (ip) => {
        outboundPtr.set(ip, await lookupPtr(ip, ptrCache));
      }));
    }

    // 2) groupKey 決定: hint > PTR > IP の優先順で集約
    const groupMap = new Map<string, OutboundGroup>();
    for (const [key, count] of outboundByDst.entries()) {
      const [proto, hp, hint] = splitN(key, '|', 3);
      const [remote_ip, remote_port] = splitN(hp, ':', 2);
      const ptr = !hint ? (outboundPtr.get(remote_ip) || '') : '';
      const groupKey = hint || ptr || remote_ip || '(unknown)';
      let g = groupMap.get(groupKey);
      if (!g) {
        g = {
          key: groupKey,
          is_domain: !!hint || !!ptr,
          hint: hint || '',
          derived_from_ptr: !hint && !!ptr,
          friendly_name: null,
          remotes: [],
          total_count: 0,
          unique_ips: 0,
          registered: false,
          is_localhost: false,
        };
        groupMap.set(groupKey, g);
      }
      g.remotes.push({ proto, remote_ip, remote_port, count });
      g.total_count += count;
    }
    for (const g of groupMap.values()) {
      g.remotes.sort((a, b) => b.count - a.count);
      g.unique_ips = new Set(g.remotes.map((r) => r.remote_ip).filter(Boolean)).size;
      g.registered = registered.has(g.key);
      // is_localhost: 全 remote が link-local / loopback / APIPA に該当する場合
      g.is_localhost = g.remotes.length > 0
        && g.remotes.every((r) => localhostCidrs(r.remote_ip));
      // well-known 辞書を引いてサービス名 (Anthropic / Cloudflare 等) を付ける
      g.friendly_name = lookupFriendlyName({
        hint: g.hint,
        ptr: g.derived_from_ptr ? g.key : '',
        remote_ips: g.remotes.map((r) => r.remote_ip).filter(Boolean),
      });
      // ── プロセス紐付け (outbound のみ): 各 remote と group 全体に attach ──
      // remotes.processes は per-remote (= detail rows で表示)、
      // g.processes は group 全体 (= header で 1〜2 件チラ見せ用)。
      const procAgg = new Map<string, number>();
      for (const r of g.remotes) {
        const key = `${r.proto}|${r.remote_ip}|${r.remote_port}`;
        // proto は raw.tsv 由来 (TCP/TLSv1.2/TLSv1.3/UDP/QUIC/DNS 等)、
        // 一方 Sysmon/snapshot は 'TCP'/'UDP' しか持たないので
        // L4 へ落として再探索する fallback も用意。
        const procs = procByRemote.get(key) || procByRemote.get(`${l4Of(r.proto)}|${r.remote_ip}|${r.remote_port}`);
        if (procs && procs.size > 0) {
          const list = [...procs.entries()].sort((a, b) => b[1] - a[1]);
          r.processes = list.map(([n]) => n);
          for (const [n, c] of list) procAgg.set(n, (procAgg.get(n) || 0) + c);
        }
      }
      if (procAgg.size > 0) {
        g.processes = [...procAgg.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => ({ name, count }));
      }
    }
    out.outbound = [...groupMap.values()]
      .sort((a, b) => b.total_count - a.total_count)
      .slice(0, topN);
  }

  // outbound hint top N
  out.outbound_hints = [...outboundByHint.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([hint, count]) => ({ hint, count }));

  // ── inbound: 逆引き PTR を全 src IP に当てて、 同じ PTR は 1 行にまとめる。
  //    PTR が引けなかった IP はそのまま IP キーで分離 (= "(unknown)" にまとめない)。
  {
    // src の unique IP を先に集めて並列逆引き
    const uniqueIps = new Set<string>();
    for (const key of inboundBySrc.keys()) {
      const [, hp] = splitN(key, '|', 2);
      const [ip] = splitN(hp, ':', 2);
      if (ip) uniqueIps.add(ip);
    }
    const ipToName = new Map<string, string>();
    if (resolvePtr) {
      await Promise.all([...uniqueIps].map(async (ip) => {
        ipToName.set(ip, await lookupPtr(ip, ptrCache));
      }));
    }

    const groupMap = new Map<string, InboundGroup>();
    for (const [key, count] of inboundBySrc.entries()) {
      const [proto, hp] = splitN(key, '|', 2);
      const [remote_ip, remote_port] = splitN(hp, ':', 2);
      const name = ipToName.get(remote_ip) || '';
      const groupKey = name || remote_ip || '(unknown)';
      let g = groupMap.get(groupKey);
      if (!g) {
        g = {
          key: groupKey,
          is_domain: !!name,
          remote_name: name,
          friendly_name: null,
          remotes: [],
          total_count: 0,
          unique_ips: 0,
          registered: false,
          is_localhost: false,
        };
        groupMap.set(groupKey, g);
      }
      g.remotes.push({ proto, remote_ip, remote_port, count });
      g.total_count += count;
    }
    for (const g of groupMap.values()) {
      g.remotes.sort((a, b) => b.count - a.count);
      g.unique_ips = new Set(g.remotes.map((r) => r.remote_ip).filter(Boolean)).size;
      g.registered = registered.has(g.key);
      g.is_localhost = g.remotes.length > 0
        && g.remotes.every((r) => localhostCidrs(r.remote_ip));
      g.friendly_name = lookupFriendlyName({
        hint: '',
        ptr: g.remote_name || '',
        remote_ips: g.remotes.map((r) => r.remote_ip).filter(Boolean),
      });
    }
    out.inbound = [...groupMap.values()]
      .sort((a, b) => b.total_count - a.total_count)
      .slice(0, topN);
  }

  return out;
}

/** _ws.col.Protocol が "TLSv1.3" / "QUIC" / "DNS" 等の application-layer ラベルでも
 *  Sysmon/NetTCPConnection の "TCP" / "UDP" と突き合わせられるよう L4 に正規化する */
function l4Of(proto: string): string {
  const p = (proto || '').toUpperCase();
  if (p.startsWith('TLS') || p === 'HTTP' || p === 'HTTPS' || p === 'SSH') return 'TCP';
  if (p === 'QUIC' || p === 'DNS' || p === 'DHCP' || p === 'NTP' || p === 'MDNS' || p === 'SSDP') return 'UDP';
  return p;
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

async function lookupPtr(
  ip: string,
  cache: Map<string, string>,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  if (!opts.force && cache.has(ip)) return cache.get(ip) || '';
  const timeoutMs = opts.timeoutMs ?? 350;
  // 短い timeout で best-effort (= UI 応答性を優先)。 force 時は長め (= 手動 retry)
  try {
    const r = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('ptr-timeout')), timeoutMs)),
    ]);
    const name = Array.isArray(r) && r.length > 0 ? r[0] : '';
    cache.set(ip, name);
    return name;
  } catch {
    cache.set(ip, '');
    return '';
  }
}

/** tshark のパスを解決する (Wireshark 既定 → PATH)。 */
function findTsharkPath(): string {
  const env = process.env.MEMORIA_TSHARK_BIN;
  if (env && fs.existsSync(env)) return env;
  const win = 'C:\\Program Files\\Wireshark\\tshark.exe';
  if (fs.existsSync(win)) return win;
  return 'tshark';
}

/** capture filter (BPF) を target IP/domain から組み立てる。 */
function makeBpfFilter(target: string): string {
  if (/^[0-9a-fA-F.:]+$/.test(target)) {
    // IP らしい
    return `host ${target}`;
  }
  // domain として扱い、 解決した IP を or で並べる関数は重いので、 BPF は
  // ホスト名指定にする (libpcap が getaddrinfo してくれる)。
  // 入力にメタ文字が混ざる可能性に備えて簡易サニタイズ。
  const safe = target.replace(/[^A-Za-z0-9.\-_]/g, '');
  return `host ${safe}`;
}

/** display filter (Wireshark filter) を組み立てる (SNI/HTTP host で当てる)。 */
function makeDisplayFilter(target: string): string {
  if (/^[0-9a-fA-F.:]+$/.test(target)) return `ip.addr == ${target}`;
  const safe = target.replace(/"/g, '');
  return `tls.handshake.extensions_server_name == "${safe}" or http.host == "${safe}" or dns.qry.name == "${safe}"`;
}

/** on-demand に tshark を回して中身を取る。 max_packets / max_seconds で打ち切り。 */
async function runInspect(
  target: string,
  adapterIndex: number,
  maxPackets: number,
  maxSeconds: number,
): Promise<InspectResult> {
  const tsharkPath = findTsharkPath();
  const bpf = makeBpfFilter(target);
  const display = makeDisplayFilter(target);
  const args = [
    '-i', String(adapterIndex),
    '-l', '-n',
    '-c', String(maxPackets),
    '-a', `duration:${maxSeconds}`,
    '-f', bpf,
    '-Y', display,
    '-V',                           // verbose: 各 packet を decoded text で
  ];

  return new Promise<InspectResult>((resolve) => {
    const result: InspectResult = {
      target,
      adapter_index: adapterIndex,
      bpf_filter: bpf,
      display_filter: display,
      max_packets: maxPackets,
      max_seconds: maxSeconds,
      finished_at: '',
      packets: 0,
      text: '',
      error: null,
    };
    let stdout = '';
    let stderr = '';
    const proc = spawn(tsharkPath, args, { windowsHide: true });
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
      if (stdout.length > 256 * 1024) {
        stdout = stdout.slice(0, 256 * 1024) + '\n... (truncated)';
        try { proc.kill('SIGINT'); } catch { /* ignore */ }
      }
    });
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    const killTimer = setTimeout(() => { try { proc.kill('SIGINT'); } catch { /* ignore */ } },
      (maxSeconds + 2) * 1000);
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      result.finished_at = new Date().toISOString();
      // tshark の -V は "Frame N: ... " の区切りで連なる。 件数概算。
      result.packets = (stdout.match(/^Frame \d+: /gm) || []).length;
      result.text = stdout.trim();
      if (code !== 0 && code !== null && !result.text) {
        result.error = stderr.trim().split('\n').slice(-5).join('\n') || `tshark exited ${code}`;
      } else if (!result.text) {
        result.error = stderr.trim().split('\n').slice(-5).join('\n') || '対象のパケットを観測できませんでした';
      }
      resolve(result);
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      result.finished_at = new Date().toISOString();
      result.error = err.message;
      resolve(result);
    });
  });
}

export interface PacketMonitorRouterDeps {
  dataDir?: string;
  /** AI 分析 (identify-with-ai / identify-process) を投入する一般 queue。
   *  渡されなかった場合は queue を経由せずに直接 LLM を叩く (= テスト用)。 */
  aiAnalysisQueue?: FifoQueue;
}

export function makePacketMonitorRouter(deps: PacketMonitorRouterDeps = {}): Hono {
  const r = new Hono();
  // PTR キャッシュは process 寿命だけ保持 (= ローカル名前の変更頻度を考えれば十分)。
  const ptrCache = new Map<string, string>();
  const registered = new RegisteredStore();
  registered.init(deps.dataDir || null);

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

    // 更新ごとに inspect キャッシュを破棄 (= 「中身はメモリに置き更新で破棄」)
    inspectCache.clear();

    // ── プロセス紐付け map を 1 回だけ取得 (= 全アダプタで再利用) ──
    // since_minutes が 0 (= 全期間) の時は Sysmon の探索範囲を 5 分にデフォルト
    const procSinceMin = sinceMin > 0 ? Math.min(60, sinceMin) : 5;
    const procResult = await getProcessAttribution(procSinceMin);
    // key = `${proto}|${remote_ip}|${remote_port}` → Map<process_name, count>
    const procByRemote = new Map<string, Map<string, number>>();
    for (const p of procResult.processes) {
      for (const f of p.outbound) {
        const k = `${f.proto}|${f.remote_ip}|${f.remote_port}`;
        let m = procByRemote.get(k);
        if (!m) { m = new Map(); procByRemote.set(k, m); }
        m.set(p.process, (m.get(p.process) || 0) + f.count);
      }
    }

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
        adapterDir, meta, sinceEpoch, topN, resolvePtr, ptrCache, registered, procByRemote,
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

  // ── well-known エンドポイント 辞書 (= 内蔵 IP/PTR/host 辞書、 read-only) ──
  r.get('/api/packet-monitor/well-known', (c: Context) => {
    return c.json({ items: WELL_KNOWN_RULES });
  });

  // ── プロセス別 IN/OUT (Sysmon Event 3 + Get-NetTCPConnection スナップショット) ──
  //   ?since_minutes=N  (Sysmon の取得範囲、 既定 5)
  //   ?top_n=N          (プロセス上位件数、 既定 30)
  //   ?per_proc_top=N   (各プロセスの remote 上位件数、 既定 10)
  // PowerShell を spawn するので 30s キャッシュ済。
  r.get('/api/packet-monitor/processes', async (c: Context) => {
    const sinceMin = Math.max(1, Math.min(60, Number(c.req.query('since_minutes')) || 5));
    const topN = Math.max(1, Math.min(200, Number(c.req.query('top_n')) || 30));
    const perTop = Math.max(1, Math.min(50, Number(c.req.query('per_proc_top')) || 10));
    const r2 = await getProcessAttribution(sinceMin);
    return c.json({
      ...r2,
      processes: r2.processes.slice(0, topN).map((p) => ({
        ...p,
        outbound: p.outbound.slice(0, perTop),
        inbound: p.inbound.slice(0, perTop),
      })),
    });
  });

  // ── 登録済み宛先 (= ユーザが「確認した OK」 と印を付けたドメイン / IP) ──
  r.get('/api/packet-monitor/registered', (c: Context) => {
    return c.json({ items: registered.list() });
  });
  r.post('/api/packet-monitor/registered', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { key?: unknown; note?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    const note = typeof body?.note === 'string' ? body.note : '';
    if (!key) return c.json({ error: 'key is required' }, 400);
    const entry = registered.add(key, note);
    return c.json({ item: entry }, 201);
  });
  r.delete('/api/packet-monitor/registered/:key', (c: Context) => {
    const key = decodeURIComponent(c.req.param('key') ?? '');
    const ok = registered.remove(key);
    return c.json({ ok });
  });

  // ── PTR 逆引き 再試行 (= 「? 不明」 を クリックされたとき) ─────────────
  //   body: { ips: string[], force?: boolean, timeout_ms?: number }
  //   返り値: { results: { ip: string, name: string }[] }
  // 通常 summary 時の逆引きは 350ms タイムアウトで「best-effort」 だが、
  // ここはユーザの明示的アクション なので 3 秒まで待つ + force=true で
  // cache を bypass する。
  r.post('/api/packet-monitor/lookup-ptr', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      { ips?: unknown; force?: unknown; timeout_ms?: unknown } | null;
    const ips = Array.isArray(body?.ips) ? body!.ips.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
    const force = body?.force === true;
    const timeoutMs = Math.max(100, Math.min(5000, Number(body?.timeout_ms) || 3000));
    if (ips.length === 0) return c.json({ error: 'ips[] is required' }, 400);

    const results = await Promise.all(ips.map(async (ip) => {
      const name = await lookupPtr(ip, ptrCache, { force, timeoutMs });
      return { ip, name };
    }));
    return c.json({ results });
  });

  // ── 接続先 AI 識別 (= 「? 不明」 隣の 🤖 AI ボタン) ─────────────────
  //   body: {
  //     target,
  //     remotes: [{ proto, remote_ip, remote_port, count }],
  //     hint?, ptr?,
  //     processes?: string[]  (= Sysmon / snapshot 由来で観測したプロセス名)
  //   }
  //   返り値: { name, confidence, reasoning }
  // LLM は llm.runLlm({ task: 'endpoint_identify', prompt }) を経由。
  // JSON 形式での返答を期待 (fence で囲まれていても抽出)。
  r.post('/api/packet-monitor/identify-with-ai', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      target?: unknown;
      remotes?: unknown;
      hint?: unknown;
      ptr?: unknown;
      processes?: unknown;
    } | null;
    const target = typeof body?.target === 'string' ? body.target.trim() : '';
    if (!target) return c.json({ error: 'target is required' }, 400);
    const remotesRaw = Array.isArray(body?.remotes) ? body!.remotes : [];
    const remotes = (remotesRaw as Array<Record<string, unknown>>).slice(0, 20).map((r) => ({
      proto: String(r?.proto ?? ''),
      remote_ip: String(r?.remote_ip ?? ''),
      remote_port: String(r?.remote_port ?? ''),
      count: Number(r?.count) || 0,
    }));
    const hint = typeof body?.hint === 'string' ? body.hint.trim() : '';
    const ptr = typeof body?.ptr === 'string' ? body.ptr.trim() : '';
    const processes = Array.isArray(body?.processes)
      ? (body!.processes as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [];

    const remotesText = remotes.length === 0
      ? '(なし)'
      : remotes.map((r) => `  - ${r.proto} ${r.remote_ip}:${r.remote_port} (count: ${r.count})`).join('\n');

    const prompt = [
      'あなたは ネットワーク エンドポイント を観測情報から識別する専門家です。',
      '以下の観測情報から、 この接続先がどのサービスやアプリケーションのものかを推定してください。',
      '',
      `観測した宛先キー: ${target}`,
      `観測した remote 一覧:`,
      remotesText,
      hint ? `TLS SNI / HTTP host / DNS query: ${hint}` : 'TLS SNI / HTTP host / DNS query: (取れず)',
      ptr  ? `逆引き PTR: ${ptr}`                       : '逆引き PTR: (取れず)',
      processes.length > 0
        ? `接続を出していたプロセス: ${processes.join(', ')}`
        : '接続を出していたプロセス: (不明)',
      '',
      '返答は **JSON のみ** で、 以下のキーを持ってください:',
      '  name (短いサービス名 — 例: "Anthropic Claude API", "Cloudflare Tunnel POP", "Google Public DNS")',
      '  confidence (0.0 〜 1.0)',
      '  reasoning (1〜2 文の根拠)',
      '',
      '確信が持てない (confidence < 0.3) 時は name="Unknown" を返してください。',
      '余分な ``` fence は不要。 JSON だけ。',
    ].join('\n');

    let rawText = '';
    try {
      // FifoQueue.enqueue は wrapped 内で result を捨てる設計 (= 副作用ベース) なので、
      // 結果は外側 closure 経由で受ける。 enqueue 失敗時の例外も外に伝播する。
      const work = async () => { rawText = await runLlm({ task: 'endpoint_identify', prompt, timeoutMs: 90_000 }); };
      if (deps.aiAnalysisQueue) {
        await deps.aiAnalysisQueue.enqueue(work, {
          kind: 'packetmon_endpoint_identify',
          title: `🛡 接続先 AI 識別: ${target}`,
        });
      } else {
        await work();
      }
    } catch (e) {
      return c.json({ error: `LLM 呼び出し失敗: ${(e as Error).message}` }, 502);
    }

    // JSON 抽出 (fence で囲まれていても拾う)
    let parsed: { name?: unknown; confidence?: unknown; reasoning?: unknown } | null = null;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonCandidate = (fenceMatch ? fenceMatch[1] : rawText).trim();
    const braceMatch = jsonCandidate.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { parsed = JSON.parse(braceMatch[0]) as typeof parsed; } catch { /* ignore */ }
    }
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const confidence = typeof parsed?.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning.trim() : '';
    if (!name) {
      return c.json({
        name: 'Unknown', confidence: 0, reasoning: '(LLM 応答を JSON として解釈できませんでした)',
        raw: rawText.slice(0, 1000),
      });
    }
    return c.json({ name, confidence, reasoning, raw: rawText.length > 1000 ? rawText.slice(0, 1000) + '…' : rawText });
  });

  // ── プロセス AI 解析 (= 「このプロセスが何の exe か」 を LLM に問う) ─
  //   body: {
  //     process: string,              // 例: "svchost.exe"
  //     pids?: number[],
  //     paths?: string[],              // 観測した exe フルパス (= 一番ヒント力大)
  //     outbound?: [{proto, ip, port, count}],  // top N の接続先
  //     inbound?:  [{proto, ip, port, count}],
  //   }
  //   → { vendor, product, category, description, expected_behavior, confidence, raw }
  r.post('/api/packet-monitor/identify-process', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      process?: unknown; pids?: unknown; paths?: unknown;
      outbound?: unknown; inbound?: unknown;
    } | null;
    const procName = typeof body?.process === 'string' ? body.process.trim() : '';
    if (!procName) return c.json({ error: 'process is required' }, 400);
    const paths = Array.isArray(body?.paths)
      ? (body!.paths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5)
      : [];
    const pids = Array.isArray(body?.pids)
      ? (body!.pids as unknown[]).filter((x): x is number => typeof x === 'number').slice(0, 10)
      : [];

    function summarizeFlows(arr: unknown): string {
      if (!Array.isArray(arr)) return '(なし)';
      const top = (arr as Array<Record<string, unknown>>).slice(0, 8).map((f) => {
        const proto = String(f?.proto ?? '');
        const ip = String(f?.remote_ip ?? '');
        const port = String(f?.remote_port ?? '');
        const count = Number(f?.count) || 0;
        return `  - ${proto} ${ip}:${port} (count: ${count})`;
      });
      return top.length === 0 ? '(なし)' : top.join('\n');
    }

    const prompt = [
      'あなたは Windows プロセス と そこから観測される通信パターンから「これは何の exe か」 を判定する専門家です。',
      '以下のプロセス情報から、 そのプロセスがどんなアプリ / サービスなのか推定してください。',
      '',
      `プロセス名: ${procName}`,
      pids.length > 0 ? `観測 PID: ${pids.join(', ')}` : '観測 PID: (なし)',
      paths.length > 0
        ? `観測した exe パス:\n${paths.map((p) => `  - ${p}`).join('\n')}`
        : '観測した exe パス: (取得失敗 = SYSTEM 権限 / サービスの可能性)',
      '',
      'OUTBOUND 通信 (上位):',
      summarizeFlows(body?.outbound),
      '',
      'INBOUND 通信 (上位):',
      summarizeFlows(body?.inbound),
      '',
      '返答は **JSON のみ** で、 以下のキーを持ってください:',
      '  vendor (例: "Microsoft", "Anthropic", "Apple", "Tailscale Inc.", "Acronis")',
      '  product (例: "Windows Service Host", "Claude Desktop", "Bonjour", "Tailscale daemon")',
      '  category (system / browser / messaging / vpn / antivirus / dev-tool / sync / ai / gaming / other のいずれか)',
      '  description (1〜2 文の説明)',
      '  expected_behavior (典型的なネットワーク挙動 1 文。 例: 「自社 update サーバへ定期 HTTPS で接続」)',
      '  confidence (0.0 〜 1.0)',
      '',
      '確信が持てない (confidence < 0.3) 時は product="Unknown" を返してください。',
      '余分な ``` fence は不要。 JSON だけ。',
    ].join('\n');

    let rawText = '';
    try {
      const work = async () => { rawText = await runLlm({ task: 'endpoint_identify', prompt, timeoutMs: 90_000 }); };
      if (deps.aiAnalysisQueue) {
        await deps.aiAnalysisQueue.enqueue(work, {
          kind: 'packetmon_process_identify',
          title: `🔧 プロセス AI 解析: ${procName}`,
        });
      } else {
        await work();
      }
    } catch (e) {
      return c.json({ error: `LLM 呼び出し失敗: ${(e as Error).message}` }, 502);
    }

    // JSON 抽出
    let parsed: Record<string, unknown> | null = null;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonCandidate = (fenceMatch ? fenceMatch[1] : rawText).trim();
    const braceMatch = jsonCandidate.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { parsed = JSON.parse(braceMatch[0]) as Record<string, unknown>; } catch { /* ignore */ }
    }
    const safeStr = (k: string) => typeof parsed?.[k] === 'string' ? (parsed[k] as string).trim() : '';
    const out = {
      vendor:            safeStr('vendor'),
      product:           safeStr('product') || 'Unknown',
      category:          safeStr('category') || 'other',
      description:       safeStr('description'),
      expected_behavior: safeStr('expected_behavior'),
      confidence:        typeof parsed?.confidence === 'number'
                           ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      raw: rawText.length > 1000 ? rawText.slice(0, 1000) + '…' : rawText,
    };
    return c.json(out);
  });

  // ── 中身確認 (on-demand tshark) ────────────────────────────────────
  r.post('/api/packet-monitor/inspect', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as {
      target?: unknown; adapter_index?: unknown;
      max_packets?: unknown; max_seconds?: unknown;
    } | null;
    const target = typeof body?.target === 'string' ? body.target.trim() : '';
    if (!target) return c.json({ error: 'target is required' }, 400);
    const adapterIndex = Math.max(1, Math.min(99, Number(body?.adapter_index) || 1));
    const maxPackets = Math.max(1, Math.min(200, Number(body?.max_packets) || 30));
    const maxSeconds = Math.max(1, Math.min(15, Number(body?.max_seconds) || 5));

    // 既キャッシュ あればそれを返す (= 同じ summary 内で 2 回目以降は即時)
    const cacheKey = `${adapterIndex}|${target}`;
    const cached = inspectCache.get(cacheKey);
    if (cached) return c.json({ item: cached, cached: true });

    const result = await runInspect(target, adapterIndex, maxPackets, maxSeconds);
    inspectCache.set(cacheKey, result);
    return c.json({ item: result, cached: false });
  });

  return r;
}
