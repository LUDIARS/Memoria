// Memoria server プロセスが動いている OS の「接続中の WiFi 名 (SSID)」 を取る。
//
// もともと PR #132 で Electron main process に同等のコードを置いて
// `window.memoria.getCurrentWifiInfo()` 経由で renderer に渡していたが、
// それだと **Electron 内蔵のレンダラからしか SSID が見えない** という制約が
// あった。 Memoria server を Electron で起動して、 別 PC のブラウザ / スマホ
// PWA / Chrome 拡張 から接続している場合に SSID が出せない。
//
// → server プロセス自体が OS native コマンドで SSID を取るようにする。 取得元は
//   Memoria server を実行している PC (= 家の Electron 内蔵サーバ 1 台) なので
//   どのクライアントから REST で取りに行っても同じ値が返る。
//
// 各 OS の native CLI (すべて読み取り専用、 sudo 不要):
//   Windows : `netsh wlan show interfaces` の "SSID" / "BSSID" 行をパース
//   macOS   : `networksetup -getairportnetwork en0` (SSID のみ)。 newer macOS は
//             airport が restricted のため BSSID は best-effort
//   Linux   : `iwgetid -r` (SSID) と `iwgetid -ar` (BSSID)、 無ければ nmcli

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface WifiInfo {
  ssid: string | null;
  bssid: string | null;
  platform: NodeJS.Platform;
}

/** 失敗時 (= 取得経路無し / 未接続 / 権限不足) は null。 */
export async function getCurrentWifiInfo(): Promise<WifiInfo | null> {
  const platform = process.platform;
  try {
    if (platform === 'win32') return await wifiInfoWindows();
    if (platform === 'darwin') return await wifiInfoMac();
    if (platform === 'linux') return await wifiInfoLinux();
  } catch {
    // server プロセスの stdout を汚さないよう silent fail。 上位で null 扱い。
  }
  return null;
}

async function wifiInfoWindows(): Promise<WifiInfo | null> {
  const r = await execFileP('netsh', ['wlan', 'show', 'interfaces'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const lines = (r.stdout || '').split(/\r?\n/);
  let ssid: string | null = null;
  let bssid: string | null = null;
  for (const line of lines) {
    const m = /^\s*(?:SSID|BSSID)\b[^\:]*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    // BSSID 行は前置に「BSSID」 を含む。 SSID 行のみ純粋な「SSID」 で始まる。
    if (/^\s*BSSID/.test(line) && !bssid) bssid = m[1] ?? null;
    else if (/^\s*SSID/.test(line) && !ssid) ssid = m[1] ?? null;
    if (ssid && bssid) break;
  }
  return ssid || bssid ? { ssid, bssid, platform: 'win32' } : null;
}

async function wifiInfoMac(): Promise<WifiInfo | null> {
  try {
    const r = await execFileP('networksetup', ['-getairportnetwork', 'en0'], { encoding: 'utf8' });
    const m = /Current Wi-Fi Network:\s*(.+?)\s*$/m.exec(r.stdout || '');
    const ssid = m?.[1] ?? null;
    let bssid: string | null = null;
    try {
      const apt = await execFileP(
        '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport',
        ['-I'],
        { encoding: 'utf8' },
      );
      const b = /\bBSSID:\s*([0-9a-f:]+)\s*$/im.exec(apt.stdout || '');
      bssid = b?.[1] ?? null;
    } catch { /* airport restricted on Sonoma+ */ }
    return ssid ? { ssid, bssid, platform: 'darwin' } : null;
  } catch {
    return null;
  }
}

async function wifiInfoLinux(): Promise<WifiInfo | null> {
  let ssid: string | null = null;
  let bssid: string | null = null;
  try { const r = await execFileP('iwgetid', ['-r'], { encoding: 'utf8' }); ssid = r.stdout.trim() || null; }
  catch { /* try nmcli */ }
  try { const r = await execFileP('iwgetid', ['-ar'], { encoding: 'utf8' }); bssid = r.stdout.trim() || null; }
  catch { /* skip */ }
  if (!ssid) {
    try {
      const r = await execFileP('nmcli', ['-t', '-f', 'active,ssid,bssid', 'dev', 'wifi'], { encoding: 'utf8' });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        // nmcli の bssid フィールド内 ':' は '\\:' で escape されているので分解
        const parts = line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':'));
        if (parts[0] === 'yes') { ssid = parts[1] || ssid; bssid = parts[2] || bssid; break; }
      }
    } catch { /* nmcli 不在 */ }
  }
  return ssid || bssid ? { ssid, bssid, platform: 'linux' } : null;
}
