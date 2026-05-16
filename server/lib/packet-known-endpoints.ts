// パケット監視 タブ用の 「well-known エンドポイント辞書」 — 接続先が
// IP / PTR / host のいずれかで明らかに識別できる場合に、 短い分かりやすい
// サービス名を返す。 マッチしなければ null。
//
// 個人情報ではなくサービス識別ヒントなのでソース内 const として持つ。
// ユーザが追加したい場合は本ファイルにエントリを追記してビルドしなおす
// 想定 (= ホットリロード対応の DB は v0.2 で検討)。
//
// マッチ規則:
//   host_suffix : SNI/HTTP host/DNS query (= group.hint) or PTR が指定文字列
//                 で終わる
//   host_exact  : 同上 完全一致
//   ptr_suffix  : PTR (= group.key, derived_from_ptr=true) が指定文字列で
//                 終わる (host_suffix と差別化するための明示版)
//   ip_cidr     : remote_ip が指定 CIDR に入る (IPv4 のみ)
//
// 優先順 (上から下、 最初にマッチしたものを返す):
//   1. host (hint または PTR)
//   2. ip CIDR

export interface WellKnownRule {
  name: string;
  match:
    | { type: 'host_suffix'; value: string }
    | { type: 'host_exact';  value: string }
    | { type: 'ptr_suffix';  value: string }
    | { type: 'ip_cidr';     value: string };
}

export const WELL_KNOWN_RULES: WellKnownRule[] = [
  // ── AI / API providers ────────────────────────────────────────────
  { name: 'Anthropic (Claude API)',     match: { type: 'host_suffix', value: 'anthropic.com' } },
  { name: 'Anthropic (Claude.ai)',      match: { type: 'host_suffix', value: 'claude.ai' } },
  { name: 'OpenAI',                     match: { type: 'host_suffix', value: 'openai.com' } },
  { name: 'OpenAI (ChatGPT)',           match: { type: 'host_suffix', value: 'chatgpt.com' } },
  { name: 'Google AI (Gemini)',         match: { type: 'host_suffix', value: 'aistudio.google.com' } },
  { name: 'Google AI (Gemini API)',     match: { type: 'host_suffix', value: 'generativelanguage.googleapis.com' } },
  { name: 'Mistral AI',                 match: { type: 'host_suffix', value: 'mistral.ai' } },
  { name: 'GroqCloud',                  match: { type: 'host_suffix', value: 'groq.com' } },

  // ── Cloudflare ────────────────────────────────────────────────────
  { name: 'Cloudflare',                 match: { type: 'host_suffix', value: 'cloudflare.com' } },
  { name: 'Cloudflare (Tunnel)',        match: { type: 'host_suffix', value: 'cloudflarewarp.com' } },
  { name: 'Cloudflare (Tunnel)',        match: { type: 'host_suffix', value: 'argotunnel.com' } },
  { name: 'Cloudflare DNS (1.1.1.1)',   match: { type: 'ip_cidr',     value: '1.1.1.1/32' } },
  { name: 'Cloudflare DNS (1.0.0.1)',   match: { type: 'ip_cidr',     value: '1.0.0.1/32' } },
  // Cloudflare Tunnel POPs (= argotunnel.com の anycast)。 自宅 cloudflared が常時 7844/UDP を張る
  { name: 'Cloudflare (Tunnel POP)',    match: { type: 'ip_cidr',     value: '198.41.192.0/19' } },
  { name: 'Cloudflare (anycast)',       match: { type: 'ip_cidr',     value: '104.16.0.0/12' } },
  { name: 'Cloudflare (anycast)',       match: { type: 'ip_cidr',     value: '162.159.0.0/16' } },
  { name: 'Cloudflare (anycast)',       match: { type: 'ip_cidr',     value: '172.64.0.0/13' } },

  // ── Google ────────────────────────────────────────────────────────
  { name: 'Google DNS (8.8.8.8)',       match: { type: 'ip_cidr',     value: '8.8.8.8/32' } },
  { name: 'Google DNS (8.8.4.4)',       match: { type: 'ip_cidr',     value: '8.8.4.4/32' } },
  { name: 'Google',                     match: { type: 'host_suffix', value: 'google.com' } },
  { name: 'Google Cloud',               match: { type: 'host_suffix', value: 'googleusercontent.com' } },
  { name: 'YouTube',                    match: { type: 'host_suffix', value: 'youtube.com' } },
  { name: 'YouTube',                    match: { type: 'host_suffix', value: 'googlevideo.com' } },
  { name: 'Gmail',                      match: { type: 'host_suffix', value: 'gmail.com' } },

  // ── Amazon / AWS ──────────────────────────────────────────────────
  { name: 'AWS EC2 (Tokyo)',            match: { type: 'host_suffix', value: '.ap-northeast-1.compute.amazonaws.com' } },
  { name: 'AWS EC2 (Oregon)',           match: { type: 'host_suffix', value: '.us-west-2.compute.amazonaws.com' } },
  { name: 'AWS EC2 (N.Virginia)',       match: { type: 'host_suffix', value: '.us-east-1.compute.amazonaws.com' } },
  { name: 'AWS EC2',                    match: { type: 'host_suffix', value: '.compute.amazonaws.com' } },
  { name: 'AWS',                        match: { type: 'host_suffix', value: '.amazonaws.com' } },
  { name: 'Amazon',                     match: { type: 'host_suffix', value: 'amazon.com' } },
  { name: 'Amazon Japan',               match: { type: 'host_suffix', value: 'amazon.co.jp' } },

  // ── CDN / Hosting ─────────────────────────────────────────────────
  { name: 'Akamai CDN',                 match: { type: 'host_suffix', value: '.akamaitechnologies.com' } },
  { name: 'Akamai CDN',                 match: { type: 'host_suffix', value: '.akamaiedge.net' } },
  { name: 'Linode',                     match: { type: 'host_suffix', value: '.linodeusercontent.com' } },
  { name: 'Fastly',                     match: { type: 'host_suffix', value: '.fastly.net' } },
  { name: 'DigitalOcean',               match: { type: 'host_suffix', value: '.digitalocean.com' } },

  // ── Microsoft ─────────────────────────────────────────────────────
  { name: 'Microsoft',                  match: { type: 'host_suffix', value: 'microsoft.com' } },
  { name: 'Microsoft (Windows Update)', match: { type: 'host_suffix', value: 'windowsupdate.com' } },
  { name: 'Microsoft Office 365',       match: { type: 'host_suffix', value: 'office.com' } },
  { name: 'Microsoft Office 365',       match: { type: 'host_suffix', value: 'office365.com' } },
  { name: 'Microsoft Bing',             match: { type: 'host_suffix', value: 'bing.com' } },
  { name: 'OneDrive',                   match: { type: 'host_suffix', value: 'onedrive.com' } },

  // ── Apple ─────────────────────────────────────────────────────────
  { name: 'Apple',                      match: { type: 'host_suffix', value: 'apple.com' } },
  { name: 'iCloud',                     match: { type: 'host_suffix', value: 'icloud.com' } },

  // ── Dev / OSS infra ───────────────────────────────────────────────
  { name: 'GitHub',                     match: { type: 'host_suffix', value: 'github.com' } },
  { name: 'GitHub',                     match: { type: 'host_suffix', value: 'githubusercontent.com' } },
  { name: 'npm',                        match: { type: 'host_suffix', value: 'npmjs.org' } },
  { name: 'npm',                        match: { type: 'host_suffix', value: 'npmjs.com' } },
  { name: 'PyPI',                       match: { type: 'host_suffix', value: 'pypi.org' } },
  { name: 'Docker Hub',                 match: { type: 'host_suffix', value: 'docker.io' } },
  { name: 'Datadog',                    match: { type: 'host_suffix', value: 'datadoghq.com' } },
  { name: 'Sentry',                     match: { type: 'host_suffix', value: 'sentry.io' } },
  { name: 'Open-Meteo (Weather API)',   match: { type: 'host_suffix', value: 'open-meteo.com' } },
  { name: 'OwnTracks (Iv MQTT)',        match: { type: 'host_suffix', value: 'owntracks.org' } },

  // ── Communication ────────────────────────────────────────────────
  { name: 'Slack',                      match: { type: 'host_suffix', value: 'slack.com' } },
  { name: 'Discord',                    match: { type: 'host_suffix', value: 'discord.com' } },
  { name: 'Discord',                    match: { type: 'host_suffix', value: 'discordapp.com' } },
  { name: 'Zoom',                       match: { type: 'host_suffix', value: 'zoom.us' } },
  { name: 'Teams',                      match: { type: 'host_suffix', value: 'teams.microsoft.com' } },
  { name: 'X (Twitter)',                match: { type: 'host_suffix', value: 'x.com' } },
  { name: 'X (Twitter)',                match: { type: 'host_suffix', value: 'twitter.com' } },

  // ── Gaming / others ──────────────────────────────────────────────
  { name: 'Steam',                      match: { type: 'host_suffix', value: 'steampowered.com' } },
  { name: 'Steam',                      match: { type: 'host_suffix', value: 'steamcommunity.com' } },
  { name: 'Epic Games',                 match: { type: 'host_suffix', value: 'epicgames.com' } },
  { name: 'Spotify',                    match: { type: 'host_suffix', value: 'spotify.com' } },
  { name: 'Netflix',                    match: { type: 'host_suffix', value: 'netflix.com' } },

  // ── ローカル LUDIARS infra (= 自宅で動かしている標準的なもの) ──
  { name: 'Tailscale (control)',        match: { type: 'host_suffix', value: 'tailscale.com' } },
  { name: 'Tailscale (DERP)',           match: { type: 'host_suffix', value: '.derp.tailscale.com' } },
];

// ── 内部実装 ───────────────────────────────────────────────────────

/** "1.2.3.4" を 32bit number へ。 失敗時は null。 */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const b = Number(m[i]);
    if (b < 0 || b > 255) return null;
    n = (n * 256) + b;
  }
  return n >>> 0;
}

/** "1.2.3.0/24" 形式の CIDR に ip が入るか。 */
function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(cidr);
    return a !== null && a === b;
  }
  const net = cidr.substring(0, slash);
  const bits = Number(cidr.substring(slash + 1));
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function hostSuffixMatch(target: string, value: string): boolean {
  if (!target || !value) return false;
  const t = target.toLowerCase();
  const v = value.toLowerCase();
  if (v.startsWith('.')) return t.endsWith(v) || t === v.substring(1);
  return t === v || t.endsWith('.' + v);
}

export interface LookupParams {
  /** SNI / HTTP host / DNS query — packet 由来のドメイン (or '') */
  hint: string;
  /** PTR で取れたドメイン (or '') */
  ptr: string;
  /** group が抱えている remote IP の一覧 (IPv4 想定) */
  remote_ips: string[];
}

/** 接続先 well-known 名を返す。 マッチしなければ null。 */
export function lookupFriendlyName(p: LookupParams): string | null {
  const hosts: string[] = [];
  if (p.hint) hosts.push(p.hint);
  if (p.ptr && p.ptr !== p.hint) hosts.push(p.ptr);
  for (const rule of WELL_KNOWN_RULES) {
    if (rule.match.type === 'host_suffix' || rule.match.type === 'ptr_suffix') {
      const sources = rule.match.type === 'ptr_suffix' ? [p.ptr] : hosts;
      for (const h of sources) if (hostSuffixMatch(h, rule.match.value)) return rule.name;
    } else if (rule.match.type === 'host_exact') {
      for (const h of hosts) if (h.toLowerCase() === rule.match.value.toLowerCase()) return rule.name;
    }
  }
  // host-based でマッチしなかったら IP CIDR を試す
  for (const rule of WELL_KNOWN_RULES) {
    if (rule.match.type !== 'ip_cidr') continue;
    for (const ip of p.remote_ips) {
      if (ipInCidr(ip, rule.match.value)) return rule.name;
    }
  }
  return null;
}
