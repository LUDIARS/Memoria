#!/usr/bin/env node
//
// Prepare `desktop/src-tauri/resources/` for `cargo tauri build`.
//
//   resources/
//   ├── server/      ← copy of ../../server/ (excluding dev junk)
//   └── node/<plat>/ ← portable Node runtime per host platform
//
// Tauri's `bundle.resources` then ships those into the installer; main.rs
// uses MEMORIA_NODE_BIN + MEMORIA_SERVER_DIR resolved relative to the
// executable to spawn the server with the bundled runtime.
//
// Re-run before each release:
//   node scripts/bundle-server.mjs --node-version=22.11.0
//
// Defaults are tuned for the current Memoria layout. Node tarballs are
// fetched from nodejs.org/dist; the script verifies the tarball SHA256
// against nodejs.org's SHASUMS256.txt.

import { existsSync, mkdirSync, rmSync, createWriteStream, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'server');
const RESOURCES = resolve(__dirname, '..', 'src-tauri', 'resources');

// ── arg parsing (--key=value) ─────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).flatMap(a => {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    return m ? [[m[1], m[2]]] : [];
  })
);
const NODE_VERSION = args['node-version'] || '22.11.0';
const targetPlatform = args.platform || hostPlatform();

function hostPlatform() {
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
const NODE_TARBALLS = {
  'win-x64':       `node-v${NODE_VERSION}-win-x64.zip`,
  'darwin-arm64':  `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  'darwin-x64':    `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
  'linux-x64':     `node-v${NODE_VERSION}-linux-x64.tar.xz`,
  'linux-arm64':   `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
};

function log(...m) { console.log('[bundle-server]', ...m); }
function fatal(msg) { console.error('[bundle-server] FATAL', msg); process.exit(1); }

function run(cmd, argv, opts = {}) {
  log('$', cmd, argv.join(' '));
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) fatal(`${cmd} exited ${r.status}`);
}

// ── 1. snapshot server/ into resources/server/ ────────────────────────────
function snapshotServer() {
  const dst = join(RESOURCES, 'server');
  log('clearing', dst);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });

  // Copy *.js, *.json, public/, multi/ but skip node_modules (re-installed
  // production-only below) and any local data/heartbeat artifacts.
  const skipDirs = new Set(['node_modules', 'data', '.env', '.cache', 'multi']);
  copyTree(SERVER_SRC, dst, (rel) => {
    const top = rel.split(/[\\/]/)[0];
    if (skipDirs.has(top)) return false;
    if (rel.endsWith('.env')) return false;
    return true;
  });

  log('npm install --omit=dev', dst);
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dst });
}

function copyTree(src, dst, accept) {
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const rel = ent.name;
    const from = join(src, rel);
    const to = join(dst, rel);
    if (!accept(rel)) continue;
    if (ent.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, (sub) => accept(`${rel}/${sub}`));
    } else if (ent.isFile()) {
      copyFileSync(from, to);
    }
  }
}

// ── 2. fetch + extract a portable Node runtime ───────────────────────────
async function fetchNode() {
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
    await pipeline(Readable.fromWeb(res.body), createWriteStream(local));
  }

  // Verify against SHASUMS256.txt.
  const shaUrl = `${NODE_DIST_BASE}/SHASUMS256.txt`;
  log('verifying SHA256 from', shaUrl);
  const sha = await (await fetch(shaUrl)).text();
  const wantLine = sha.split('\n').find(l => l.endsWith(`  ${tarball}`));
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
    // Windows
    run('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force "${local}" "${out}"`,
    ]);
  } else {
    run('tar', ['-xf', local, '-C', out, '--strip-components=1']);
  }

  // Sanity check: bin/node must exist.
  const nodeBin = targetPlatform.startsWith('win-')
    ? join(out, 'node.exe')
    : join(out, 'bin', 'node');
  if (!existsSync(nodeBin)) fatal(`extracted node not found at ${nodeBin}`);
  log('node bin', nodeBin);
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  log('repo root:', REPO_ROOT);
  log('target platform:', targetPlatform);
  log('node version:', NODE_VERSION);
  mkdirSync(RESOURCES, { recursive: true });
  snapshotServer();
  await fetchNode();
  log('done. resources/ ready for `cargo tauri build`.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
