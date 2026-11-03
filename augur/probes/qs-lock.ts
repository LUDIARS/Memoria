import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { QsLockSnapshot } from '../contracts/qs-lock.contract.ts';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:ceaf70aa */
import augurContract_f3d6f68d from '../contracts/qs-lock.contract.ts'; /* augur-inject:contract-predicate:1a796192 */

// Read real lockfiles and the immutable baseline; the predicate checks the diff.
export function qsLockEvidence(registry: QsLockSnapshot['registry'], base: string): QsLockSnapshot {
  const locks = ['server/package-lock.json', 'mcp-server/package-lock.json'].map(file => ({
    before: JSON.parse(execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' })),
    after: JSON.parse(readFileSync(file, 'utf8')),
  }));
  return { registry, locks };
}
// @ts-expect-error augur-inject
qsLockEvidence = contract(qsLockEvidence, { ...augurContract_f3d6f68d, contractId: 'C-25', mode: 'observe', sample: 1, where: 'augur/probes/qs-lock.ts:5', rule: 'contract-wrap', id: 'f3d6f68d' }); /* augur-inject:contract-wrap:f3d6f68d */
