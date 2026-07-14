// concordia-spawn-client.ts — Memoria → Concordia /v1/spawn 経路の薄い client。
//
// 役割: ローカル直 spawn (agent-dispatch.ts の現行挙動) の代替として、
// Concordia + Lictor が動いているなら wt タブで対話 session を起動して
// prompt を inject する 4 段。
//
//   1. GET /v1/spawn/info   → token_path を引く (no auth)
//   2. fs.read(token_path)  → Bearer token を読む
//   3. POST /v1/spawn       → wt タブで lictor-wrapped Claude/Codex を起動
//   4. POST /v1/sessions/:id/inject → prompt を pty に流し込む
//
// 3 と 4 の間に Lictor が Concordia に register する待ち時間がある。
// `GET /v1/sessions?status=active&provider=...` を poll して、
// `repo_path === cwd && started_at_sec > spawnTs - 2` を満たす session を
// 拾う。 通常 2-5 秒で見える。
//
// すべての関数は失敗時に Error を throw する (silent fallback はしない —
// 「選択式」 spec を守るため。 spec/feature/concordia-runner.md)。

import { readFileSync } from 'node:fs';

export interface ConcordiaSpawnClientOptions {
  /** Concordia loopback URL. 既定 http://127.0.0.1:17330 */
  url?: string;
  /** fetch timeout per call (既定 5s; poll は別 timeout を持つ) */
  timeoutMs?: number;
  /** test 注入用 fetch (既定 global fetch) */
  fetchImpl?: typeof fetch;
  /** test 注入用 file reader (既定 readFileSync) */
  readFileSyncImpl?: (path: string, encoding: 'utf8') => string;
}

export type ConcordiaProvider = 'claude' | 'codex' | 'gemini';

export interface SpawnInfoResult {
  token_path: string;
  platform_supported: boolean;
  default_cwd: string;
}

export interface SpawnResult {
  ok: true;
  id: string;
  pid: number | null;
  command: string[];
}

export interface SessionRow {
  id: string;
  provider: string;
  repo_path: string;
  status: string;
  started_at: number;
  // 残りカラムは使わないので柔軟に
  [k: string]: unknown;
}

/** Lictor が Concordia に register 完了するまで poll する既定 timeout。 */
export const DEFAULT_SESSION_DISCOVERY_TIMEOUT_MS = 30_000;
/** Poll 1 周期。 1s で十分 (Lictor 起動に数秒かかる)。 */
export const DEFAULT_SESSION_DISCOVERY_INTERVAL_MS = 1_000;

export class ConcordiaSpawnClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly readFileSyncImpl: (path: string, encoding: 'utf8') => string;
  private cachedToken: { path: string; value: string } | null = null;

  constructor(opts: ConcordiaSpawnClientOptions = {}) {
    this.url = (opts.url ?? 'http://127.0.0.1:17330').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readFileSyncImpl =
      opts.readFileSyncImpl ?? ((p, enc) => readFileSync(p, enc) as string);
  }

  /** Returns the Concordia base URL (no trailing slash) for logging. */
  get baseUrl(): string {
    return this.url;
  }

  /** GET /v1/spawn/info — no auth. Returns token_path + platform info. */
  async getSpawnInfo(): Promise<SpawnInfoResult> {
    const res = await this.req('GET', '/v1/spawn/info');
    const body = (await res.json()) as Partial<SpawnInfoResult>;
    if (typeof body.token_path !== 'string') {
      throw new Error('spawn/info: malformed response (no token_path)');
    }
    return {
      token_path: body.token_path,
      platform_supported: !!body.platform_supported,
      default_cwd: typeof body.default_cwd === 'string' ? body.default_cwd : '',
    };
  }

  /**
   * Load + cache the spawn Bearer token. Re-reads on every spawn call (= no
   * cross-spawn caching) by design — Concordia rotates the token on restart
   * and we want to honor that without a Memoria restart. Override with
   * `forceFresh: false` only when calling repeatedly in a tight loop.
   */
  async loadToken(opts: { forceFresh?: boolean } = {}): Promise<string> {
    const forceFresh = opts.forceFresh ?? true;
    if (!forceFresh && this.cachedToken) return this.cachedToken.value;
    const info = await this.getSpawnInfo();
    let raw: string;
    try {
      raw = this.readFileSyncImpl(info.token_path, 'utf8');
    } catch (e) {
      throw new Error(
        `spawn token unreadable: ${info.token_path}: ${(e as Error).message}`,
      );
    }
    const value = raw.trim();
    if (!value) {
      throw new Error(`spawn token file is empty: ${info.token_path}`);
    }
    this.cachedToken = { path: info.token_path, value };
    return value;
  }

  /**
   * POST /v1/spawn — launches a wt tab with lictor-wrapped Claude/Codex.
   * `cwd` should be the absolute project path. `title` shows in the wt tab
   * header. `args` are appended verbatim after the provider binary.
   */
  async spawn(input: {
    provider: ConcordiaProvider;
    cwd: string;
    mode?: 'tab' | 'window';
    title?: string;
    args?: string[];
  }): Promise<SpawnResult> {
    const token = await this.loadToken();
    const body = {
      provider: input.provider,
      mode: input.mode ?? 'tab',
      cwd: input.cwd,
      title: input.title,
      args: input.args,
    };
    const res = await this.req('POST', '/v1/spawn', { body, token });
    const json = (await res.json()) as { ok?: boolean; id?: string; pid?: number; command?: string[]; error?: string };
    if (!res.ok || json.ok !== true) {
      throw new Error(
        `spawn failed (${res.status}): ${json.error ?? JSON.stringify(json)}`,
      );
    }
    if (typeof json.id !== 'string') {
      throw new Error('spawn response missing id');
    }
    return {
      ok: true,
      id: json.id,
      pid: typeof json.pid === 'number' ? json.pid : null,
      command: Array.isArray(json.command) ? json.command : [],
    };
  }

  /**
   * Poll `GET /v1/sessions?status=active&provider=...` until a session
   * matching `repoPath` + `started_at > minStartedAtSec` appears, or the
   * timeout elapses. Returns the discovered session id, or null on timeout.
   *
   * `minStartedAtSec` should be the Unix-second timestamp captured *before*
   * the spawn call, with a small grace window subtracted (e.g. -2s) so
   * tiny clock skew doesn't lose the freshly registered session.
   */
  async waitForSession(input: {
    provider: ConcordiaProvider;
    repoPath: string;
    minStartedAtSec: number;
    timeoutMs?: number;
    intervalMs?: number;
    /** test override — replaces real-time sleep so tests don't wait. */
    sleep?: (ms: number) => Promise<void>;
  }): Promise<string | null> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_SESSION_DISCOVERY_TIMEOUT_MS;
    const intervalMs = input.intervalMs ?? DEFAULT_SESSION_DISCOVERY_INTERVAL_MS;
    const sleep = input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const concordiaProvider = providerToConcordia(input.provider);
    const normalizedRepoPath = normalizeRepoPath(input.repoPath);
    const deadline = Date.now() + timeoutMs;
    do {
      const url = `/v1/sessions?status=active&provider=${encodeURIComponent(concordiaProvider)}`;
      let res;
      try {
        res = await this.req('GET', url);
      } catch {
        // transient — try again
        await sleep(intervalMs);
        continue;
      }
      let body: { sessions?: SessionRow[] };
      try {
        body = (await res.json()) as { sessions?: SessionRow[] };
      } catch {
        await sleep(intervalMs);
        continue;
      }
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      const match = sessions.find(
        (s) =>
          normalizeRepoPath(s.repo_path) === normalizedRepoPath &&
          typeof s.started_at === 'number' &&
          s.started_at >= input.minStartedAtSec,
      );
      if (match) return match.id;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    } while (Date.now() < deadline);
    return null;
  }

  /** POST /v1/sessions/:id/inject — pushes the prompt into the pty. */
  async inject(input: { sessionId: string; text: string; source?: string }): Promise<void> {
    if (!input.text) throw new Error('inject: text required');
    const body = { text: input.text, source: input.source ?? 'memoria' };
    const res = await this.req('POST', `/v1/sessions/${encodeURIComponent(input.sessionId)}/inject`, {
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok !== true) {
      throw new Error(`inject failed (${res.status}): ${json.error ?? JSON.stringify(json)}`);
    }
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private async req(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; token?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers['authorization'] = `Bearer ${init.token}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(`concordia ${method} ${path}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * runConcordiaFlow が必要とする最小インターフェース。 HTTP 実装 (ConcordiaSpawnClient)
 * と、 設定パスからフォルダ越しに動的 import される Concordia モジュール実装の両方が
 * これを満たす。 動的モジュール側は createConcordiaSpawn(options) でこの形を返す。
 */
export type ConcordiaSpawnApi =
  Pick<ConcordiaSpawnClient, 'spawn' | 'waitForSession' | 'inject'> & { baseUrl?: string };

/**
 * Concordia は provider 名として `claude-code` / `codex-cli` / `gemini-cli` を
 * 期待する (Lictor `provider.concordiaProvider` 由来)。 Memoria の AgentKind
 * (`claude_code` / `codex` / `gemini`) → Concordia の `provider` フィルタ値に
 * 変換するために、 同じ /v1/spawn の input は短縮形 (`claude` / `codex` /
 * `gemini`) を使う点に注意。
 */
function providerToConcordia(p: ConcordiaProvider): string {
  if (p === 'claude') return 'claude-code';
  if (p === 'codex') return 'codex-cli';
  return 'gemini-cli';
}

/**
 * Windows のパス差異 (`/` vs `\`、 ドライブレターの大小、 末尾 `/`) を吸収する
 * 比較用正規化。 Memoria が project.path を Concordia に渡し、 Lictor が
 * 折り返してきたパスと突き合わせるための片寄せ。
 */
function normalizeRepoPath(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** test-only re-export. */
export const __test = { providerToConcordia, normalizeRepoPath };
