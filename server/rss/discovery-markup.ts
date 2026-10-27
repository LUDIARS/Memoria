import type { DiscoveredFeed } from './types.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:b4028721 */
import augurContract_256b0f84 from '../../augur/contracts/rss-discovery-title.contract.js'; /* augur-inject:contract-predicate:9f82d076 */
import augurContract_a5995ed5 from '../../augur/contracts/rss-discovery-links.contract.js'; /* augur-inject:contract-predicate:9c10e0f5 */

/** Extract the display title from a feed body without performing I/O. */
export function extractFeedTitle(body: string): string | null {
  const opening = /<title/i.exec(body);
  if (!opening) return null;
  const start = body.indexOf('>', opening.index + 6);
  if (start === -1) return null;
  // Fold ASCII only: Unicode lowercasing can expand characters and shift offsets.
  const folded = body.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const end = folded.indexOf('</title>', start + 1);
  if (end === -1) return null;
  return body.slice(start + 1, end).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
// @ts-expect-error augur-inject
extractFeedTitle = contract(extractFeedTitle, { ...augurContract_256b0f84, contractId: 'C-23', mode: 'observe', sample: 1, where: 'server/rss/discovery-markup.ts:4', rule: 'contract-wrap', id: '256b0f84' }); /* augur-inject:contract-wrap:256b0f84 */

/** Extract unique RSS/Atom alternate links without performing I/O. */
export function extractFeedLinks(body: string, siteUrl: string): Pick<DiscoveredFeed, 'url' | 'title'>[] {
  const out: Pick<DiscoveredFeed, 'url' | 'title'>[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(body)) !== null) {
    const end = body.indexOf('>', linkRe.lastIndex);
    if (end === -1) break;
    // Each tag is consumed once. Never retry a missing terminator from later starts.
    const tag = body.slice(match.index, end + 1);
    linkRe.lastIndex = end + 1;
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let abs: string;
    try { abs = new URL(href, siteUrl).toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const title = tag.match(/title\s*=\s*["']([^"']*)["']/i)?.[1] || null;
    out.push({ url: abs, title: title ? title.trim().slice(0, 200) : null });
  }
  return out;
}
// @ts-expect-error augur-inject
extractFeedLinks = contract(extractFeedLinks, { ...augurContract_a5995ed5, contractId: 'C-24', mode: 'observe', sample: 1, where: 'server/rss/discovery-markup.ts:17', rule: 'contract-wrap', id: 'a5995ed5' }); /* augur-inject:contract-wrap:a5995ed5 */
