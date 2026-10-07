import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:0f905855 */
import augurContract_1a32cc63 from '../../augur/contracts/security-html.contract.js'; /* augur-inject:contract-predicate:2ef8b909 */
/** Applied to the document response, including direct navigation outside the UI. */
export function storedHtmlHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
// @ts-expect-error augur-inject
storedHtmlHeaders = contract(storedHtmlHeaders, { ...augurContract_1a32cc63, contractId: 'C-9', mode: 'observe', sample: 1, where: 'server/lib/stored-html.ts:2', rule: 'contract-wrap', id: '1a32cc63' }); /* augur-inject:contract-wrap:1a32cc63 */
