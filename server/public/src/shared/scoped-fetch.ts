const tokens: Partial<Record<'admin' | 'bookmark', string>> = {};

/** 管理用 token が要る設定 API (帰宅・出発通知 / LINE)。 */
function isAdminSettingsPath(path: string): boolean {
  return path === '/api/home-presence' || path.startsWith('/api/home-presence/') || path.startsWith('/api/line/');
}

/** Credentials stay in this tab's memory and are sent only to the exact scoped endpoints. */
export async function scopedFetch(path: string, options?: RequestInit): Promise<Response> {
  const scope = path === '/api/llm/config' || isAdminSettingsPath(path) ? 'admin'
    : path === '/api/bookmark' || path === '/api/bookmarks/from-url'
      || /^\/api\/bookmarks\/\d+\/resummarize$/.test(path) ? 'bookmark' : null;
  if (!scope) return fetch(path, options);
  const send = (): Promise<Response> => {
    const headers = new Headers(options?.headers);
    if (tokens[scope]) headers.set(`X-Memoria-${scope}-Token`, tokens[scope]);
    return fetch(path, { ...options, headers, redirect: 'error' });
  };
  const response = await send();
  if (response.status !== 403) return response;
  const token = window.prompt(scope === 'admin'
    ? '設定管理用 token を入力してください（このタブだけで保持します）'
    : 'ブックマーク取込用 token を入力してください（このタブだけで保持します）');
  if (!token?.trim()) return response;
  tokens[scope] = token.trim();
  return send();
}
