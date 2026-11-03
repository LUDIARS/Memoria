import { strict as assert } from 'node:assert';
import { qsLockEvidence } from './qs-lock.ts';
import predicate, { type QsLockSnapshot } from '../contracts/qs-lock.contract.ts';

const response = await fetch('https://registry.npmjs.org/qs/6.16.2');
if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
const result = qsLockEvidence(await response.json() as QsLockSnapshot['registry'], process.argv[2] ?? '1994be58eb4082b22a8bdd3c711aa15774979022');
assert.equal(predicate.post(result), true);
// Reject a stale vulnerable version, a parent update and corrupted integrity.
for (const mutate of [
  (value: QsLockSnapshot) => { value.locks[0].after.packages['node_modules/qs'].version = '6.16.0'; },
  (value: QsLockSnapshot) => { value.locks[0].after.packages['node_modules/body-parser'].version = '9.0.0'; },
  (value: QsLockSnapshot) => { value.locks[1].after.packages['node_modules/qs'].integrity = 'invalid'; },
]) {
  const invalid = structuredClone(result);
  mutate(invalid);
  assert.notEqual(predicate.post(invalid), true);
}
