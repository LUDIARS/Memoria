// Memoria server が動いている PC の「いま最前面にあるアプリ」 を周期サンプリング
// する。 結果は `app_samples` テーブルに 1 行ずつ insert。 集計 (= 今日 X 時間
// Code.exe を使った 等) は別 endpoint で count * sample_interval_sec から算出。
//
// プライバシ:
// - feature flag `features.activity.app_sampling.enabled` (default false) で
//   opt-in。 OFF の間は一切起動しない
// - 取得対象は **最前面ウィンドウの process 名 + window title のみ**。 全プロセス
//   列挙はしない (= ノイズ + メモリ重い + ユーザの興味は前面アプリ)
//
// 各 OS の native CLI (すべて読み取り専用、 sudo 不要):
//   Windows : PowerShell + Win32 API (GetForegroundWindow / GetWindowText /
//             GetWindowThreadProcessId → process name lookup)
//   macOS   : `osascript` (System Events → frontmost process)
//   Linux   : `xdotool getactivewindow getwindowname` + `xdotool getwindowpid`

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ForegroundApp {
  process_name: string;
  window_title: string | null;
  platform: NodeJS.Platform;
}

export async function getForegroundApp(): Promise<ForegroundApp | null> {
  const platform = process.platform;
  try {
    if (platform === 'win32') return await foregroundWindows();
    if (platform === 'darwin') return await foregroundMac();
    if (platform === 'linux') return await foregroundLinux();
  } catch (e) {
    // 詳細ログは debug 用に出す (= サーバ stdout は info+ のみが望ましいので silent)
    void e;
  }
  return null;
}

// ── Windows ─────────────────────────────────────────────────────────────
// PowerShell から Win32 API を呼ぶ。 Add-Type で C# inline 定義 → GetForegroundWindow
// + GetWindowTextW + GetWindowThreadProcessId を使う。 出力は JSON で渡す。
//
// 別アプローチとして UI Automation (System.Windows.Forms) でも取れるが、
// PowerShell 起動 + Add-Type のコストは ~150ms 程度なので、 30 秒に 1 回なら
// 許容できる。
const PS_FOREGROUND_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Mem {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$h = [Mem]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output '{}'; exit }
$len = [Mem]::GetWindowTextLength($h)
$sb = New-Object System.Text.StringBuilder($len + 2)
[Mem]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
$title = $sb.ToString()
[uint32]$pid = 0
[Mem]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
$p = $null
try { $p = Get-Process -Id $pid -ErrorAction Stop } catch { }
$name = if ($p) { $p.ProcessName } else { 'unknown' }
[pscustomobject]@{ process_name = $name; window_title = $title } | ConvertTo-Json -Compress
`;

async function foregroundWindows(): Promise<ForegroundApp | null> {
  const r = await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_FOREGROUND_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const out = (r.stdout || '').trim();
  if (!out) return null;
  try {
    const j = JSON.parse(out) as { process_name?: string; window_title?: string };
    if (!j.process_name) return null;
    return {
      process_name: j.process_name,
      window_title: j.window_title || null,
      platform: 'win32',
    };
  } catch {
    return null;
  }
}

// ── macOS ──────────────────────────────────────────────────────────────
async function foregroundMac(): Promise<ForegroundApp | null> {
  // 最前面 process の name + その window title (= System Events の「frontmost
  // application 」 + 最初の window の title)。 sandbox 制約 (Accessibility 許可)
  // が無いと name は取れるが window title が空になることがある。
  const script = `
tell application "System Events"
  set frontApp to first process whose frontmost is true
  set procName to name of frontApp
  set winTitle to ""
  try
    set winTitle to name of front window of frontApp
  end try
  return procName & "|" & winTitle
end tell`;
  const r = await execFileP('osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 });
  const out = (r.stdout || '').trim();
  if (!out) return null;
  const [name, title = ''] = out.split('|', 2);
  if (!name) return null;
  return { process_name: name, window_title: title || null, platform: 'darwin' };
}

// ── Linux (X11 専用 — Wayland は xdotool が動かないので別途対応が要る) ──
async function foregroundLinux(): Promise<ForegroundApp | null> {
  // xdotool で前面 window の id → name → pid → process name の順で取る。
  // Wayland 環境では失敗する。 その場合は GNOME extension などが必要だが、
  // ここでは silent fail に留める。
  const id = (await execFileP('xdotool', ['getactivewindow'], { encoding: 'utf8' })).stdout.trim();
  if (!id) return null;
  const title = (await execFileP('xdotool', ['getwindowname', id], { encoding: 'utf8' })).stdout.trim();
  let processName = 'unknown';
  try {
    const pidStr = (await execFileP('xdotool', ['getwindowpid', id], { encoding: 'utf8' })).stdout.trim();
    const pid = Number(pidStr);
    if (Number.isFinite(pid)) {
      const c = await execFileP('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
      processName = c.stdout.trim() || processName;
    }
  } catch { /* leave 'unknown' */ }
  return { process_name: processName, window_title: title || null, platform: 'linux' };
}

// silence unused suppression — spawn は将来 streaming sampler で使う可能性
void spawn;
