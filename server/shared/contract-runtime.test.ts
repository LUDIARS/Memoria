import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { contract } from './contract-runtime.js';

interface Event { level: string; msg: string; ctx: Record<string, string> }

const WHERE = { contractId: 'C-T', id: 'marker01', where: 'test.ts:1' };

/** Point the runtime at a fresh log directory and set LOG_WEAVER; both are restored afterwards. */
async function observing(context: TestContext, logWeaver: string | undefined): Promise<() => Promise<Event[]>> {
  const directory = await mkdtemp(join(tmpdir(), 'memoria-contract-runtime-'));
  const saved = { dir: process.env.VESTIGIUM_LOGS_DIR, weaver: process.env.LOG_WEAVER };
  process.env.VESTIGIUM_LOGS_DIR = directory;
  if (logWeaver === undefined) delete process.env.LOG_WEAVER;
  else process.env.LOG_WEAVER = logWeaver;
  context.after(async () => {
    restore('VESTIGIUM_LOGS_DIR', saved.dir);
    restore('LOG_WEAVER', saved.weaver);
    await rm(directory, { recursive: true, force: true });
  });
  return async () => {
    const text = await readFile(join(directory, 'contracts.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Event);
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('a satisfied contract is observed and the result passes through', async (context) => {
  const events = await observing(context, '1');
  const wrapped = contract((n: number) => n * 2, { ...WHERE, post: (result: number, n: number) => result === n * 2 });
  assert.equal(wrapped(21), 42);
  const [event, ...rest] = await events();
  assert.equal(rest.length, 0);
  assert.equal(event.msg, 'contract observed');
  assert.equal(event.ctx.phase, 'ok');
  assert.equal(event.ctx.contract, 'C-T');
  assert.equal(event.ctx.id, 'marker01');
  assert.match(event.ctx.observed_at, /Z$/);
});

test('false and string verdicts are recorded as violations, never as observations', async (context) => {
  const events = await observing(context, '1');
  assert.equal(contract(() => 1, { ...WHERE, post: () => false })(), 1);
  assert.equal(contract(() => 2, { ...WHERE, post: () => 'usd must equal the breakdown sum' })(), 2);
  const recorded = await events();
  assert.deepEqual(recorded.map((e) => [e.msg, e.ctx.phase, e.ctx.reason]), [
    ['contract violated', 'post', 'predicate returned false'],
    ['contract violated', 'post', 'usd must equal the breakdown sum'],
  ]);
});

test('a pre violation suppresses the observation of that call', async (context) => {
  const events = await observing(context, '1');
  contract((n: number) => n, { ...WHERE, pre: (n: number) => n > 0 || 'n must be positive', post: () => true })(-1);
  assert.deepEqual((await events()).map((e) => [e.msg, e.ctx.phase]), [['contract violated', 'pre']]);
});

test('a throwing predicate is reported and never changes the result', async (context) => {
  const events = await observing(context, '1');
  const wrapped = contract(() => 'kept', {
    ...WHERE,
    post: () => { throw new Error('secret value'); },
  });
  assert.equal(wrapped(), 'kept');
  const recorded = await events();
  assert.deepEqual(recorded.map((e) => [e.msg, e.ctx.phase, e.ctx.predicate_phase]), [
    ['contract predicate threw', 'predicate', 'post'],
  ]);
  assert.doesNotMatch(JSON.stringify(recorded), /secret value/);
});

test('without LOG_WEAVER=1 no predicate runs and nothing is written', async (context) => {
  for (const value of [undefined, '0', 'true']) {
    const events = await observing(context, value);
    let evaluated = 0;
    const wrapped = contract((n: number) => n + 1, {
      ...WHERE,
      pre: () => { evaluated += 1; return true; },
      post: () => { evaluated += 1; return false; },
    });
    assert.equal(wrapped(1), 2);
    assert.equal(evaluated, 0, `LOG_WEAVER=${value}`);
    assert.deepEqual(await events(), []);
  }
});

test('an exception from the wrapped function propagates unchanged without an observation', async (context) => {
  const events = await observing(context, '1');
  const failure = new RangeError('from must not be after to');
  const wrapped = contract(() => { throw failure; }, { ...WHERE, post: () => true });
  assert.throws(() => wrapped(), (error) => error === failure);
  assert.deepEqual(await events(), []);
});

test('async results are checked after they settle and rejections pass through', async (context) => {
  const events = await observing(context, '1');
  const resolved = contract(async () => 7, { ...WHERE, post: (result: number) => result === 7 });
  assert.equal(await resolved(), 7);
  const failure = new Error('rejected');
  const rejected = contract(async () => { throw failure; }, { ...WHERE, post: () => true });
  await assert.rejects(rejected(), (error) => error === failure);
  assert.deepEqual((await events()).map((e) => e.msg), ['contract observed']);
});

test('this is forwarded to the wrapped function', async (context) => {
  await observing(context, '1');
  const target = { base: 10, add: contract(function (this: { base: number }, n: number) { return this.base + n; }, WHERE) };
  assert.equal(target.add(5), 15);
});
