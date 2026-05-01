#!/usr/bin/env node
//
// Prepare `desktop/resources/` for `electron-builder`.
//
//   resources/
//   ├── server/      ← copy of ../../server/ (excluding dev junk)
//   └── node/<plat>/ ← portable Node runtime per host platform
//
// electron-builder's `extraResources` (see desktop/package.json) ships these
// into the installer; main.ts resolves MEMORIA_NODE_BIN and
// MEMORIA_SERVER_DIR relative to `process.resourcesPath` to spawn the
// server with the bundled runtime. As a fallback main.ts can also run
// the server via Electron itself (ELECTRON_RUN_AS_NODE=1) — we still
// bundle a portable Node so the Claude / Gemini CLIs (which spawn `node`
// with a normal argv) Just Work without being aware of Electron.
//
// Re-run before each release:
//   tsx scripts/bundle-server.ts --node-version=22.11.0
//
// Defaults are tuned for the current Memoria layout. Node tarballs are
// fetched from nodejs.org/dist; the script verifies the tarball SHA256
// against nodejs.org's SHASUMS256.txt.

import {
  existsSync, mkdirSync, rmSync, createWriteStream, readFileSync,
  copyFileSync, readdirSync, renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'server');
const RESOURCES = resolve(__dirname, '..', 'resources');

type Platform =
  | 'win-x64'
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64';

// ── arg parsing (--key=value) ─────────────────────────────────────────────
const args: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).flatMap((a): [string, string][] => {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    return m ? [[m[1], m[2]]] : [];
  })
);
const NODE_VERSION = args['node-version'] || '22.11.0';
const targetPlatform: Platform = (args['platform'] as Platform | undefined) || hostPlatform();
const SKIP_NODE = args['skip-node'] === 'true' || process.env.MEMORIA_SKIP_NODE === '1';

function hostPlatform(): Platform {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'win-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  throw new Error(`unsupported host platform ${p}/${a}`);
}

const NODE_DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
const NODE_TARBALLS: Record<Platform, string> = {
  'win-x64':       `node-v${NODE_VERSION}-win-x64.zip`,
  'darwin-arm64':  `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  'darwin-x64':    `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
  'linux-x64':     `node-v${NODE_VERSION}-linux-x64.tar.xz`,
  'linux-arm64':   `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
};

function log(...m: unknown[]): void { console.log('[bundle-server]', ...m); }
function fatal(msg: string): never { console.error('[bundle-server] FATAL', msg); process.exit(1); }

function run(cmd: string, argv: string[], opts: SpawnSyncOptions = {}): void {
  log('$', cmd, argv.join(' '));
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) fatal(`${cmd} exited ${r.status ?? '?'}`);
}

// ── 1. snapshot server/ into resources/server/ ────────────────────────────
function snapshotServer(): void {
  const dst = join(RESOURCES, 'server');
  log('clearing', dst);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });

  // Copy *.js, *.json, public/ but skip node_modules (re-installed
  // production-only below), local data/heartbeat artifacts, and the
  // alternative `multi` server (Docker / Postgres — not used by the
  // desktop wrapper).
  const skipDirs = new Set(['node_modules', 'data', '.env', '.cache', 'multi']);
  copyTree(SERVER_SRC, dst, (rel: string): boolean => {
    const top = rel.split(/[\\/]/)[0];
    if (skipDirs.has(top)) return false;
    if (rel.endsWith('.env')) return false;
    return true;
  });

  log('npm install --omit=dev', dst);
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dst });
}

function copyTree(src: string, dst: string, accept: (rel: string) => boolean): void {
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const rel = ent.name;
    const from = join(src, rel);
    const to = join(dst, rel);
    if (!accept(rel)) continue;
    if (ent.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, (sub: string) => accept(`${rel}/${sub}`));
    } else if (ent.isFile()) {
      copyFileSync(from, to);
    }
  }
}

// ── 2. fetch + extract a portable Node runtime ───────────────────────────
async function fetchNode(): Promise<void> {
  const tarball = NODE_TARBALLS[targetPlatform];
  if (!tarball) fatal(`no Node tarball for ${targetPlatform}`);
  const url = `${NODE_DIST_BASE}/${tarball}`;
  const cache = resolve(__dirname, '..', '.cache', 'node');
  mkdirSync(cache, { recursive: true });
  const local = join(cache, tarball);

  if (!existsSync(local)) {
    log('fetching', url);
    const res = await fetch(url);
    if (!res.ok) fatal(`fetch ${url} → ${res.status}`);
    if (!res.body) fatal(`fetch ${url} → empty body`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(local));
  }

  // Verify against SHASUMS256.txt.
  const shaUrl = `${NODE_DIST_BASE}/SHASUMS256.txt`;
  log('verifying SHA256 from', shaUrl);
  const sha = await (await fetch(shaUrl)).text();
  const wantLine = sha.split('\n').find((l: string) => l.endsWith(`  ${tarball}`));
  if (!wantLine) fatal(`no SHA entry for ${tarball}`);
  const want = wantLine.split(/\s+/)[0];
  const got = createHash('sha256').update(readFileSync(local)).digest('hex');
  if (got !== want) fatal(`SHA mismatch for ${tarball}: want ${want}, got ${got}`);
  log('SHA OK', got.slice(0, 16) + '…');

  const out = join(RESOURCES, 'node', targetPlatform);
  log('extracting to', out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (tarball.endsWith('.zip')) {
    // Windows zip layout: node-v<x>-win-x64/{node.exe, npm.cmd, ...}.
    // Expand into a tmp dir, then flatten one level so the runtime ends up
    // at <out>/node.exe directly (matches main.ts's lookup order).
    const tmp = `${out}__tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    run('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force "${local}" "${tmp}"`,
    ]);
    const inner = readdirSync(tmp).find((n: string) => n.startsWith('node-v'));
    if (!inner) fatal(`extracted zip has no node-v* dir under ${tmp}`);
    moveContents(join(tmp, inner), out);
    rmSync(tmp, { recursive: true, force: true });
  } else {
    // tarball: --strip-components=1 flattens node-v<x>-<plat>/ into <out>/
    run('tar', ['-xf', local, '-C', out, '--strip-components=1']);
  }

  // Sanity check: node binary must exist.
  const nodeBin = targetPlatform.startsWith('win-')
    ? join(out, 'node.exe')
    : join(out, 'bin', 'node');
  if (!existsSync(nodeBin)) fatal(`extracted node not found at ${nodeBin}`);
  log('node bin', nodeBin);
}

function moveContents(srcDir: string, dstDir: string): void {
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    renameSync(join(srcDir, ent.name), join(dstDir, ent.name));
  }
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  log('repo root:', REPO_ROOT);
  log('target platform:', targetPlatform);
  log('node version:', NODE_VERSION);
  mkdirSync(RESOURCES, { recursive: true });
  snapshotServer();
  if (SKIP_NODE) {
    log('--skip-node set → Node runtime NOT bundled (main.ts will fall back to ELECTRON_RUN_AS_NODE)');
  } else {
    await fetchNode();
  }
  log('done. resources/ ready for `electron-builder`.');
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
