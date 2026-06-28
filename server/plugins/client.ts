// プラグインホスト (サイドカー) の manifest を取得する。
// 取得失敗は握りつぶさず、 呼び出し側がユーザに理由を出せるよう例外を返さず結果に載せる。

export interface PluginManifestEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  url: string;
}

export interface FetchManifestResult {
  ok: boolean;
  plugins: PluginManifestEntry[];
  error?: string;
}

export async function fetchManifest(hostUrl: string): Promise<FetchManifestResult> {
  if (!hostUrl) return { ok: false, plugins: [], error: 'プラグインホスト URL が未設定です' };
  const base = hostUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/manifest`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, plugins: [], error: `manifest 取得失敗 ${res.status}` };
    const data = (await res.json()) as { plugins?: PluginManifestEntry[] };
    return { ok: true, plugins: Array.isArray(data.plugins) ? data.plugins : [] };
  } catch (e) {
    return {
      ok: false,
      plugins: [],
      error: `プラグインホストに接続できません (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}
