import { resolveModel } from '@ludiars/one-shot';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:86969fc4 */
import augurContract_7712510c from '../../augur/contracts/llm-model.contract.js'; /* augur-inject:contract-predicate:35b129ac */

export function resolveLlmModel(provider: string, model: string, env = process.env): string {
  if (provider === 'claude' || provider === 'codex') return resolveModel(model, provider, env);
  if (provider === 'openai' && !model.trim()) throw new Error('OpenAI API model is not configured (llm.openai.model)');
  return model;
}
// @ts-expect-error augur-inject
resolveLlmModel = contract(resolveLlmModel, { ...augurContract_7712510c, contractId: 'C-26', mode: 'observe', sample: 1, where: 'server/shared/llm-model.ts:3', rule: 'contract-wrap', id: '7712510c' }); /* augur-inject:contract-wrap:7712510c */
