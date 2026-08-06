/**
 * Public, non-secret browser hosts accepted after the reverse proxy boundary.
 * Keep this explicit: each hostname must have its own access policy at the edge.
 */
export const BROWSER_HOST_CONFIG = {
  allowedHosts: [
    'memoria.ai-run-do.com',
  ],
} as const;

export function isConfiguredBrowserHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return BROWSER_HOST_CONFIG.allowedHosts.some((allowed) => allowed === normalized);
}
