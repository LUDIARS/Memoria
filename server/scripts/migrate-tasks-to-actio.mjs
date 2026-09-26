// Explicit one-shot migration. Both service URLs come from their Excubitor catalogs.
// Run with --snapshot <new local JSON path>, then add --apply to import and verify.
import { writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const apply = process.argv.includes('--apply');
const snapshotIndex = process.argv.indexOf('--snapshot');
const snapshotPath = snapshotIndex < 0 ? undefined : process.argv[snapshotIndex + 1];
const memoria = process.env.MEMORIA_URL;
const actio = process.env.ACTIO_URL;
if (!memoria || !actio || !snapshotPath || snapshotPath.startsWith('--')) {
  throw new Error('MEMORIA_URL, ACTIO_URL and --snapshot <new path> are required');
}

async function request(base, path, method = 'GET', body) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (base === actio && process.env.ACTIO_API_TOKEN) headers.authorization = `Bearer ${process.env.ACTIO_API_TOKEN}`;
  const response = await fetch(new URL(path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (base === memoria && response.headers.get('X-Memoria-Task-Backend') === 'actio') {
    throw new Error('Memoria already reads Actio; migration requires the original SQLite source');
  }
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  return response.json();
}

async function sourceTasks() {
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const result = await request(memoria, `/api/tasks?kind=all&limit=200&offset=${offset}`);
    if (!Array.isArray(result.items)) throw new Error('Invalid Memoria task response');
    rows.push(...result.items);
    if (result.items.length < 200) break;
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Source changed during pagination; retry before writing');
  return rows;
}

function sameSource(a, b) {
  const canonical = rows => JSON.stringify([...rows].sort((x, y) => x.id - y.id));
  return canonical(a) === canonical(b);
}

function payload(row) {
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.title !== 'string' || !row.title.trim()) {
    throw new Error(`Invalid source task ${row.id}`);
  }
  if (!['todo', 'doing', 'done'].includes(row.status) || !['task', 'goal'].includes(row.kind)) {
    throw new Error(`Unsupported source state ${row.id}`);
  }
  if (row.due_at && !Number.isFinite(new Date(row.due_at).getTime())) throw new Error(`Invalid deadline ${row.id}`);
  return {
    title: row.title, details: row.details, status: row.status, kind: row.kind,
    creator_type: row.creator_type, due_at: row.due_at, category: row.category,
    pluginId: 'memoria', pluginRef: `memoria:${row.id}`,
    source: 'memoria-import', sourceRef: `memoria:${row.id}`,
    // Preserve original dates, sharing metadata and the exact source record.
    pluginPayload: { memoria: row },
  };
}

function indexTasks(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid Actio task response');
  const map = new Map();
  for (const row of rows) {
    if (row.pluginId !== 'memoria' || !/^memoria:\d+$/.test(row.pluginRef ?? '')) continue;
    if (map.has(row.pluginRef)) throw new Error(`Duplicate Actio reference ${row.pluginRef}`);
    map.set(row.pluginRef, row);
  }
  return map;
}

function matches(source, target) {
  const statuses = { todo: 'open', doing: 'in_progress', done: 'done' };
  const instant = value => value ? new Date(value).getTime() : null;
  return source.title === target.title
    && (source.details ?? null) === target.description
    && statuses[source.status] === target.status && source.kind === target.kind
    && source.creator_type === target.creatorType
    && (source.category?.trim() || null) === target.category
    && instant(source.due_at) === instant(target.deadline)
    && isDeepStrictEqual(target.pluginPayload?.memoria, source);
}

const rows = await sourceTasks();
const categories = (await request(memoria, '/api/tasks/categories')).items;
if (!Array.isArray(categories)) throw new Error('Invalid Memoria categories');
const planned = rows.map(payload);
const existing = indexTasks((await request(actio, '/api/tasks?kind=all&scope=owned')).tasks);
// Refuse conflicting existing data rather than silently overwriting Actio work.
for (const row of rows) {
  const target = existing.get(`memoria:${row.id}`);
  if (target && !matches(row, target)) throw new Error(`Existing Actio task differs for Memoria ${row.id}`);
}
if (!sameSource(rows, await sourceTasks())) throw new Error('Source changed during preflight; no tasks written');
await writeFile(snapshotPath, JSON.stringify({ capturedAt: new Date().toISOString(), rows, categories }, null, 2), { encoding: 'utf8', flag: 'wx' });
process.stdout.write(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', source: rows.length, existing: existing.size, categories: categories.length }) + '\n');

if (apply) {
  let created = 0;
  for (const input of planned) {
    if (existing.has(input.pluginRef)) continue;
    // source/sourceRef is uniquely constrained by Actio, including ambiguous retries.
    const result = await request(actio, '/api/tasks', 'POST', input);
    if (!result.task?.id || !matches(input.pluginPayload.memoria, result.task)) {
      throw new Error(`Import readback mismatch for ${input.pluginRef}; stop and reconcile`);
    }
    created++;
    if (created % 100 === 0) process.stdout.write(JSON.stringify({ created }) + '\n');
  }
  for (const name of categories) await request(actio, '/api/tasks/categories', 'POST', { name });
  const imported = indexTasks((await request(actio, '/api/tasks?kind=all&scope=owned')).tasks);
  for (const row of rows) {
    const target = imported.get(`memoria:${row.id}`);
    if (!target || !matches(row, target)) throw new Error(`Final verification failed for ${row.id}`);
  }
  const targetCategories = (await request(actio, '/api/tasks/categories')).items;
  if (categories.some(name => !targetCategories.includes(name))) throw new Error('Category verification failed');
  if (!sameSource(rows, await sourceTasks())) throw new Error('Source changed during import; reconcile before switching backend');
  process.stdout.write(JSON.stringify({ verified: rows.length, created, retainedSource: true }) + '\n');
}
