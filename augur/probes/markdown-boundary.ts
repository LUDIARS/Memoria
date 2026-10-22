import { renderInline } from '../../server/public/src/shared/markdown.js';
import { renderMarkdownBlock } from '../../server/public/src/markdown-block.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:87f04ed2 */
import augurContract_1d435afa from '../contracts/markdown-inline.contract.js'; /* augur-inject:contract-predicate:746016ef */
import augurContract_943e5c3b from '../contracts/markdown-block.contract.js'; /* augur-inject:contract-predicate:290abcfa */

// Exercise the production renderers without importing Node observation into the UI.
export function renderInlineEvidence(input: string): string {
  return renderInline(input);
}
// @ts-expect-error augur-inject
renderInlineEvidence = contract(renderInlineEvidence, { ...augurContract_1d435afa, contractId: 'C-19', mode: 'observe', sample: 1, where: 'augur/probes/markdown-boundary.ts:5', rule: 'contract-wrap', id: '1d435afa' }); /* augur-inject:contract-wrap:1d435afa */

export function renderBlockEvidence(input: string): string {
  return renderMarkdownBlock(input);
}
// @ts-expect-error augur-inject
renderBlockEvidence = contract(renderBlockEvidence, { ...augurContract_943e5c3b, contractId: 'C-20', mode: 'observe', sample: 1, where: 'augur/probes/markdown-boundary.ts:9', rule: 'contract-wrap', id: '943e5c3b' }); /* augur-inject:contract-wrap:943e5c3b */
