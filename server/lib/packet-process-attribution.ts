// PowerShell を spawn して 「プロセス × 接続先」 を取得する。
// 二つのデータ源を組み合わせる:
//   1. Sysmon Event 3 (= NetworkConnect history、 outbound 主、 Initiated で方向判定)
//   2. Get-NetTCPConnection / Get-NetUDPEndpoint (= 現時点の socket snapshot)
//
// 結果は in/out 別の「プロセス × 接続先 (count)」 にまとめて返す。
// 30 秒ローカル キャッシュ で /summary 呼び出しごとに PowerShell を spawn
// しない。

import { spawn } from 'node:child_process';

export interface ProcessFlowRemote {
  proto: string;
  remote_ip: string;
  remote_port: number;
  count: number;
  source: ('sysmon' | 'tcp_state' | 'udp_endpoint')[];
}

export interface ProcessSummary {
  /** プロセス名 (例: chrome.exe)。 Sysmon の Image 末尾 or Get-Process の Name */
  process: string;
  /** PID は同じプロセス名で複数あり得るので、 観測した PID 全部 */
  pids: number[];
  /** 観測した exe フルパス (Sysmon の Image / Get-Process の Path)。
   *  同じプロセス名でも別ディレクトリから走っているケースは複数入る。
   *  取得できなかった場合は空配列 (= Windows 標準のシステムプロセス等)。 */
  paths: string[];
  /** outbound (= 自分 → remote) で観測した接続先 */
  outbound: ProcessFlowRemote[];
  /** inbound (= remote → 自分) で観測した接続元 */
  inbound: ProcessFlowRemote[];
  /** outbound + inbound 合計 (= 表示ソート用) */
  total_count: number;
}

export interface ProcessAttributionResult {
  available: boolean;
  reason: string | null;
  /** Sysmon Event 3 が取れたか (= service が動いているか) */
  sysmon_available: boolean;
  /** 今回観測したプロセス数 */
  process_count: number;
  /** 上位 N (呼び出し側で slice) — 既に total_count 降順でソート済 */
  processes: ProcessSummary[];
  generated_at: string;
}

interface RawSocket {
  src: 'tcp_state' | 'udp_endpoint';
  proto: 'TCP' | 'UDP';
  pid: number;
  proc: string;
  path: string;          // exe フルパス (取れない場合は空)
  local_ip: string;
  local_port: number;
  remote_ip: string;
  remote_port: number;
  state: string;
}
interface RawSysmonEvent {
  src: 'sysmon_event3';
  proto: string;
  pid: number;
  proc: string;
  path: string;          // Sysmon Image (= exe フルパス)
  local_ip: string;
  local_port: number;
  remote_ip: string;
  remote_port: number;
  initiated: string;       // 'true' / 'false' (XML 文字列のまま)
  time: string;
}

interface PsResult {
  sockets: RawSocket[];
  events: RawSysmonEvent[];
  sysmon_available: boolean;
  sysmon_error: string | null;
}

let _cache: { ts: number; sinceMinutes: number; data: ProcessAttributionResult } | null = null;
const CACHE_MS = 30_000;

/** Windows ephemeral port range の下限 (Win10/11 既定)。 */
const EPHEMERAL_MIN = 49152;

/** ヒューリスティック方向判定 (Sysmon Initiated が無い時に使う)。 */
function dirByPorts(localPort: number, remotePort: number): 'in' | 'out' {
  // ephemeral な local → we are client → outbound
  if (localPort >= EPHEMERAL_MIN && remotePort < EPHEMERAL_MIN) return 'out';
  // ephemeral な remote → we are server → inbound
  if (remotePort >= EPHEMERAL_MIN && localPort < EPHEMERAL_MIN) return 'in';
  // 両方 ephemeral / 両方 well-known: 既定 outbound (= self-initiated と仮定)
  return 'out';
}

/** Sysmon Initiated 文字列 → 'in' / 'out'。 不明なら null。 */
function dirByInitiated(initiated: string): 'in' | 'out' | null {
  if (initiated === 'true') return 'out';
  if (initiated === 'false') return 'in';
  return null;
}

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
# PID → @{ name; path } の辞書を 1 回だけ構築する。
# Path は SYSTEM プロセスや権限の問題で取れない場合があるので空文字許容。
$procs = @{}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $id = [int]$_.Id
    $path = ''
    try { $path = $_.Path } catch { $path = '' }
    if (-not $path) { $path = '' }
    $procs[$id] = @{ name = $_.ProcessName; path = $path }
  }
} catch {}

function Get-ProcInfo([int]$id) {
  $i = $procs[$id]
  if ($null -eq $i) { return @{ name = ''; path = '' } }
  return $i
}

# 現在のソケット (= Listen を除く Established 系)
$sockets = @()
try {
  Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { $_.State -ne 'Listen' -and $_.State -ne 'Bound' } |
    ForEach-Object {
      $i = Get-ProcInfo([int]$_.OwningProcess)
      $procName = if ($i.name) { ($i.name + '.exe').TrimStart('.') } else { '' }
      $sockets += [PSCustomObject]@{
        src        = 'tcp_state'
        proto      = 'TCP'
        pid        = [int]$_.OwningProcess
        proc       = $procName
        path       = $i.path
        local_ip   = $_.LocalAddress
        local_port = [int]$_.LocalPort
        remote_ip  = $_.RemoteAddress
        remote_port= [int]$_.RemotePort
        state      = $_.State.ToString()
      }
    }
} catch {}

# UDP は listen endpoint のみ (= 自分が server) → inbound 寄り
try {
  Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
    ForEach-Object {
      $i = Get-ProcInfo([int]$_.OwningProcess)
      $procName = if ($i.name) { ($i.name + '.exe').TrimStart('.') } else { '' }
      $sockets += [PSCustomObject]@{
        src        = 'udp_endpoint'
        proto      = 'UDP'
        pid        = [int]$_.OwningProcess
        proc       = $procName
        path       = $i.path
        local_ip   = $_.LocalAddress
        local_port = [int]$_.LocalPort
        remote_ip  = ''
        remote_port= 0
        state      = 'Listen'
      }
    }
} catch {}

# Sysmon Event 3 (= 過去 N 分の NetworkConnect)
$sysmonAvailable = $false
$sysmonError = $null
$events = @()
try {
  $start = (Get-Date).AddMinutes(-$env:MEMORIA_PACKETMON_SYSMON_MIN)
  Get-WinEvent -FilterHashtable @{
    LogName='Microsoft-Windows-Sysmon/Operational'
    Id=3
    StartTime=$start
  } -ErrorAction Stop -MaxEvents 4096 |
    ForEach-Object {
      $xml = [xml]$_.ToXml()
      $d = @{}
      foreach ($n in $xml.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
      $imagePath = if ($d['Image']) { $d['Image'] } else { '' }
      $events += [PSCustomObject]@{
        src        = 'sysmon_event3'
        proto      = ($d['Protocol'] | Out-String).Trim()
        pid        = [int]$d['ProcessId']
        proc       = if ($imagePath) { Split-Path $imagePath -Leaf } else { '?' }
        path       = $imagePath
        local_ip   = $d['SourceIp']
        local_port = [int]$d['SourcePort']
        remote_ip  = $d['DestinationIp']
        remote_port= [int]$d['DestinationPort']
        initiated  = $d['Initiated']
        time       = $_.TimeCreated.ToString('o')
      }
    }
  $sysmonAvailable = $true
} catch {
  $sysmonError = $_.Exception.Message
}

@{
  sockets = @($sockets)
  events  = @($events)
  sysmon_available = $sysmonAvailable
  sysmon_error = $sysmonError
} | ConvertTo-Json -Compress -Depth 5
`;

function runPowerShell(sinceMinutes: number): Promise<PsResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT,
    ], {
      windowsHide: true,
      env: { ...process.env, MEMORIA_PACKETMON_SYSMON_MIN: String(sinceMinutes) },
    });
    proc.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    proc.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
    }, 15_000);
    proc.on('close', () => {
      clearTimeout(killTimer);
      if (!out.trim()) {
        resolve({ sockets: [], events: [], sysmon_available: false, sysmon_error: err.trim() || 'no output' });
        return;
      }
      try {
        const parsed = JSON.parse(out) as PsResult;
        resolve(parsed);
      } catch (e) {
        resolve({ sockets: [], events: [], sysmon_available: false, sysmon_error: `parse error: ${(e as Error).message}` });
      }
    });
    proc.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ sockets: [], events: [], sysmon_available: false, sysmon_error: e.message });
    });
  });
}

export async function getProcessAttribution(sinceMinutes: number): Promise<ProcessAttributionResult> {
  const sm = Math.max(1, Math.min(60, sinceMinutes || 5));
  if (_cache && _cache.sinceMinutes === sm && (Date.now() - _cache.ts) < CACHE_MS) {
    return _cache.data;
  }
  const ps = await runPowerShell(sm);

  // プロセス名 (= proc) で集約。 in/out 別バケット + 観測 path 集合。
  interface Bucket {
    pids: Set<number>;
    paths: Set<string>;
    out: Map<string, ProcessFlowRemote>;
    in_: Map<string, ProcessFlowRemote>;
  }
  const byProc = new Map<string, Bucket>();
  function getBucket(procName: string): Bucket {
    let b = byProc.get(procName);
    if (!b) { b = { pids: new Set(), paths: new Set(), out: new Map(), in_: new Map() }; byProc.set(procName, b); }
    return b;
  }
  function pushFlow(map: Map<string, ProcessFlowRemote>, proto: string, ip: string, port: number, src: ProcessFlowRemote['source'][number]) {
    if (!ip) return;
    const key = `${proto}|${ip}|${port}`;
    let f = map.get(key);
    if (!f) { f = { proto, remote_ip: ip, remote_port: port, count: 0, source: [] }; map.set(key, f); }
    f.count++;
    if (!f.source.includes(src)) f.source.push(src);
  }

  for (const s of ps.sockets) {
    if (!s.proc || s.proc === '.exe') continue;          // PID 引けず
    if (!s.remote_ip && s.src === 'udp_endpoint') continue; // listen-only は表示しない
    const b = getBucket(s.proc);
    b.pids.add(s.pid);
    if (s.path) b.paths.add(s.path);
    const dir = dirByPorts(s.local_port, s.remote_port);
    if (dir === 'out') pushFlow(b.out, s.proto, s.remote_ip, s.remote_port, s.src);
    else pushFlow(b.in_, s.proto, s.remote_ip, s.remote_port, s.src);
  }
  for (const e of ps.events) {
    if (!e.proc) continue;
    const b = getBucket(e.proc);
    b.pids.add(e.pid);
    if (e.path) b.paths.add(e.path);
    const dir = dirByInitiated(e.initiated) ?? dirByPorts(e.local_port, e.remote_port);
    if (dir === 'out') pushFlow(b.out, e.proto, e.remote_ip, e.remote_port, 'sysmon');
    else pushFlow(b.in_, e.proto, e.remote_ip, e.remote_port, 'sysmon');
  }

  const processes: ProcessSummary[] = [];
  for (const [proc, b] of byProc) {
    const outArr = [...b.out.values()].sort((a, x) => x.count - a.count);
    const inArr  = [...b.in_.values()].sort((a, x) => x.count - a.count);
    if (outArr.length === 0 && inArr.length === 0) continue;
    const total = outArr.reduce((s, r) => s + r.count, 0) + inArr.reduce((s, r) => s + r.count, 0);
    processes.push({
      process: proc,
      pids: [...b.pids].sort((a, x) => a - x),
      paths: [...b.paths].sort(),
      outbound: outArr,
      inbound: inArr,
      total_count: total,
    });
  }
  processes.sort((a, b) => b.total_count - a.total_count);

  const result: ProcessAttributionResult = {
    available: true,
    reason: null,
    sysmon_available: !!ps.sysmon_available,
    process_count: processes.length,
    processes,
    generated_at: new Date().toISOString(),
  };
  if (!ps.sysmon_available && ps.sysmon_error) {
    result.reason = `Sysmon 取得失敗 (= 現在のソケット snapshot のみで集計): ${ps.sysmon_error.slice(0, 200)}`;
  }
  _cache = { ts: Date.now(), sinceMinutes: sm, data: result };
  return result;
}
