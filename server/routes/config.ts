// /api/setup-docs*, /api/privacy/settings, /api/llm/*, /api/maps/*, /api/queue*
// /api/locations/settings* (ingest key 管理) も含む。
// Spec: spec/api/config.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  getAppSettings, setAppSettings,
} from '../db.js';
import {
  TASKS as LLM_TASKS, PROVIDERS as LLM_PROVIDERS,
  PROVIDER_MODELS as LLM_PROVIDER_MODELS, PROVIDER_DEFAULT_MODEL as LLM_PROVIDER_DEFAULT_MODEL,
  getLlmConfig, loadLlmConfigFromSettings, settingsPatchFromConfig,
} from '../llm.js';
import type { LlmConfigPatch } from '../llm.js';
import { privacySettings } from '../lib/privacy.js';
import { getIngestKey, maskKey } from '../lib/ingest-auth.js';
import type { FifoQueue } from '../queue.js';

type Db = BetterSqlite3.Database;

const SETUP_DOCS: Record<string, { title: string; body: string }> = {
  tailscale: {
    title: 'Tailscale を使用した VPN 構築方法',
    body: '# Tailscale を使用した VPN 構築方法\n\n1. Memoria を動かす PC と、接続したい端末に Tailscale をインストールします。\n2. すべて同じ tailnet にログインします。\n3. Memoria 側の PC で `tailscale ip -4` を実行し、Tailscale IP を確認します。\n4. 端末側から `http://<tailscale-ip>:5180` を開きます。\n5. OwnTracks や Legatus を使う場合も、接続先はこの Tailscale IP にします。\n6. 外部公開が必要ない場合は、インターネットへ直接公開しないでください。',
  },
  cloudflare: {
    title: 'Cloudflare Tunnel を使用した公開方法',
    body: '# Cloudflare Tunnel を使用した公開方法\n\n1. Memoria を動かす PC に `cloudflared` をインストールします。\n2. `cloudflared tunnel login` を実行し、Tunnel を作成します。\n3. 公開ホスト名の転送先を `http://localhost:5180` に設定します。\n4. 個人データを扱うため、Cloudflare Access などで認証を必ず設定します。\n5. tailnet 外のネットワークから Web UI と `/share` が動くことを確認します。\n6. 認証なしで Memoria を直接公開しないでください。',
  },
  legatus: {
    title: 'Legatus の起動方法',
    body: '# Legatus の起動方法\n\n1. Memoria と同じ PC、または到達可能な PC で Legatus プロジェクトを開きます。\n2. 必要な取込モジュールだけを有効にします。GPS / DNS / SNI などは明示的に ON にしてください。\n3. 転送先 URL に `http://localhost:5180/api/locations/ingest` や `http://localhost:5180/api/visits/external` を設定します。\n4. Legatus 側の README に従って dev 起動またはサービス起動します。\n5. Memoria の 設定 -> 連携 / API key で Legatus の接続状態を確認します。',
  },
  sharing: {
    title: 'シェアするための設定',
    body: '# シェアするための設定\n\n1. 設定 -> データ / Hub を開きます。\n2. Memoria Hub の URL を追加し、Cernere で接続します。\n3. 公開したい Hub だけを有効にします。\n4. ブックマーク、ディグ、辞書、実装自慢は各画面のシェア操作から共有します。\n5. タスクを Actio にシェアする場合は、設定 -> プライバシー / 表示 で Actio シェアを許可し、Actio シェア URL を設定します。\n6. シェア前に内容を確認し、秘密情報や個人情報を含めないでください。',
  },
  mcp: {
    title: 'MCPサーバの設定方法',
    body: '# MCPサーバの設定方法\n\n## 概要\nMemoria MCP サーバ (mcp-server/index.js) を使うと、Claude Desktop や Claude Code からブックマーク検索・タスク操作・辞書参照などを直接呼び出せます。\n\n## 依存インストール\n```\ncd mcp-server && npm install\n```\n\n## MEMORIA_URL の設定\n環境変数 MEMORIA_URL で Memoria サーバの URL を指定します。\n- デフォルト: http://localhost:5180\n- Tailscale 経由の場合: http://<tailscale-ip>:5180\n- Cloudflare Tunnel 経由の場合: https://<your-tunnel-host>\n\n## Claude Desktop の設定\n%APPDATA%\\Claude\\claude_desktop_config.json (Windows) または\n~/Library/Application Support/Claude/claude_desktop_config.json (Mac) に以下を追加:\n\n{\n  "mcpServers": {\n    "memoria": {\n      "command": "node",\n      "args": ["C:/path/to/Memoria/mcp-server/index.js"],\n      "env": { "MEMORIA_URL": "http://localhost:5180" }\n    }\n  }\n}\n\n## Claude Code の設定\n.claude/settings.json または ~/.claude/settings.json に以下を追加:\n\n{\n  "mcpServers": {\n    "memoria": {\n      "command": "node",\n      "args": ["/path/to/Memoria/mcp-server/index.js"],\n      "env": { "MEMORIA_URL": "http://localhost:5180" }\n    }\n  }\n}\n\n## 動作確認\nClaude に以下を試してください:\n- add_task でタスクを追加\n- list_tasks でタスク一覧を取得\n- search_bookmarks でブックマーク検索\n- list_diary_entries で日記一覧を取得',
  },
};

export interface ConfigRouterDeps {
  db: Db;
  port: number;
  dataDir: string;
  /** privacy.mcp_autostart_enabled が変更されたら呼ばれる */
  onMcpAutostartChange: (enabled: boolean) => void;
  // 全 queue の snapshot を返すために必要
  summaryQueue: FifoQueue;
  cloudQueue: FifoQueue;
  digQueue: FifoQueue;
  diaryQueue: FifoQueue;
  weeklyQueue: FifoQueue;
  domainCatalogQueue: FifoQueue;
  pageMetadataQueue: FifoQueue;
  mealVisionQueue: FifoQueue;
}

export function makeConfigRouter(deps: ConfigRouterDeps): Hono {
  const {
    db, port, dataDir, onMcpAutostartChange,
    summaryQueue, cloudQueue, digQueue, diaryQueue, weeklyQueue,
    domainCatalogQueue, pageMetadataQueue, mealVisionQueue,
  } = deps;
  const r = new Hono();

  // ---- setup docs ---------------------------------------------------------
  r.get('/api/setup-docs', (c: Context) => {
    return c.json({ docs: Object.entries(SETUP_DOCS).map(([key, v]) => ({ key, title: v.title })) });
  });

  r.get('/api/setup-docs/:key', (c: Context) => {
    const key = c.req.param('key') ?? '';
    const doc = SETUP_DOCS[key];
    if (!doc) return c.json({ error: 'not found' }, 404);
    return c.json({ key, ...doc });
  });

  // ---- privacy / feature flags --------------------------------------------
  r.get('/api/privacy/settings', (c: Context) => c.json({ settings: privacySettings(db) }));

  r.patch('/api/privacy/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const [bodyKey, settingKey] of [
      ['tracks_enabled', 'features.tracks.enabled'],
      ['tracks_visible', 'features.tracks.visible'],
      ['meals_enabled', 'features.meals.enabled'],
      ['meals_visible', 'features.meals.visible'],
      ['tasks_actio_share_enabled', 'features.tasks.actio_share.enabled'],
      ['tasks_reminder_enabled', 'features.tasks.reminder.enabled'],
      ['tasks_reminder_nuntius_enabled', 'features.tasks.reminder.nuntius_enabled'],
      ['mcp_autostart_enabled', 'features.mcp.autostart.enabled'],
      ['workplace_geo_enabled', 'features.workplace.geo.enabled'],
      ['workplace_auto_share_enabled', 'features.workplace.share.enabled'],
    ] as const) {
      if (typeof body[bodyKey] === 'boolean') patch[settingKey] = body[bodyKey] ? '1' : '0';
    }
    if (typeof body.actio_share_url === 'string') patch['actio.share_url'] = body.actio_share_url.trim();
    if (typeof body.tasks_reminder_hour === 'number') patch['features.tasks.reminder.hour'] = String(Math.max(0, Math.min(23, Math.floor(body.tasks_reminder_hour))));
    if (typeof body.tasks_reminder_minute === 'number') patch['features.tasks.reminder.minute'] = String(Math.max(0, Math.min(59, Math.floor(body.tasks_reminder_minute))));
    if (typeof body.tasks_reminder_nuntius_url === 'string') patch['features.tasks.reminder.nuntius_url'] = body.tasks_reminder_nuntius_url.trim();
    if (typeof body.workplace_match_radius_m === 'number') patch['features.workplace.match.radius_m'] = String(Math.max(20, Math.min(2000, Math.floor(body.workplace_match_radius_m))));
    if (Object.keys(patch).length) setAppSettings(db, patch);
    if (Object.prototype.hasOwnProperty.call(body, 'mcp_autostart_enabled')) {
      onMcpAutostartChange(privacySettings(db).mcp_autostart_enabled);
    }
    return c.json({ settings: privacySettings(db) });
  });

  // ---- llm config -----------------------------------------------------------

  r.get('/api/llm/config', (c: Context) => {
    const cfg = getLlmConfig();
    const settings = getAppSettings(db);
    return c.json({
      config: {
        ...cfg,
        // Mask the API key when returning to FE.
        openai_api_key: cfg.openai_api_key ? '***' : '',
        openai_api_key_set: !!cfg.openai_api_key,
        // Standing memo passed to every diary generation.
        diary_global_memo: settings['diary.global_memo'] || '',
        user_profile: {
          age: settings['user.age'] ? Number(settings['user.age']) : null,
          sex: settings['user.sex'] || '',
          weight_kg: settings['user.weight_kg'] ? Number(settings['user.weight_kg']) : null,
          height_cm: settings['user.height_cm'] ? Number(settings['user.height_cm']) : null,
          activity_level: settings['user.activity_level'] || 'moderate',
        },
      },
      tasks: LLM_TASKS,
      providers: Object.entries(LLM_PROVIDERS).map(([key, v]) => ({
        key,
        label: v.label,
        kind: v.kind,
        supportsTools: v.supportsTools,
        supportsModel: v.supportsModel,
      })),
      provider_models: LLM_PROVIDER_MODELS,
      provider_default_model: LLM_PROVIDER_DEFAULT_MODEL,
      runtime: {
        // Read-only — these are fixed for the process lifetime. Exposing them
        // so the AI / Settings panel can show "Memoria is running on port X
        // with data at Y" without the user resorting to env vars.
        port,
        data_dir: dataDir,
        platform: process.platform,
      },
    });
  });

  r.patch('/api/llm/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      LlmConfigPatch & { diary_global_memo?: unknown; user_profile?: unknown };
    const patch = settingsPatchFromConfig(body);
    // Don't blow away the API key with the masked '***' value.
    if (patch['llm.openai.api_key'] === '***') delete patch['llm.openai.api_key'];
    // Diary-specific standing memo lives outside the LLM config object.
    if (typeof body.diary_global_memo === 'string') {
      patch['diary.global_memo'] = body.diary_global_memo;
    }
    // ユーザプロファイル (適正カロリー計算用)
    if (body.user_profile && typeof body.user_profile === 'object') {
      const up = body.user_profile as { age?: unknown; sex?: unknown; weight_kg?: unknown; height_cm?: unknown; activity_level?: unknown };
      if (up.age == null || (typeof up.age === 'number' && isFinite(up.age))) {
        patch['user.age'] = up.age == null ? '' : String(up.age);
      }
      if (typeof up.sex === 'string') {
        patch['user.sex'] = (up.sex === 'male' || up.sex === 'female') ? up.sex : '';
      }
      if (up.weight_kg == null || (typeof up.weight_kg === 'number' && isFinite(up.weight_kg))) {
        patch['user.weight_kg'] = up.weight_kg == null ? '' : String(up.weight_kg);
      }
      if (up.height_cm == null || (typeof up.height_cm === 'number' && isFinite(up.height_cm))) {
        patch['user.height_cm'] = up.height_cm == null ? '' : String(up.height_cm);
      }
      const validLevels = new Set(['sedentary', 'light', 'moderate', 'active', 'very_active']);
      if (typeof up.activity_level === 'string' && validLevels.has(up.activity_level)) {
        patch['user.activity_level'] = up.activity_level;
      }
    }
    setAppSettings(db, patch);
    loadLlmConfigFromSettings(getAppSettings(db));
    return c.json({ ok: true });
  });

  // ---- queue status ---------------------------------------------------------

  r.get('/api/queue', (c: Context) => {
    return c.json({
      depth: summaryQueue.depth,
      running: summaryQueue.running,
    });
  });

  r.get('/api/queue/items', (c: Context) => {
    return c.json({
      summary: summaryQueue.snapshot(),
      wordcloud: cloudQueue.snapshot(),
      dig: digQueue.snapshot(),
      diary: diaryQueue.snapshot(),
      weekly: weeklyQueue.snapshot(),
      domain: domainCatalogQueue.snapshot(),
      page: pageMetadataQueue.snapshot(),
      meal: mealVisionQueue.snapshot(),
      // Backward-compat top-level fields:
      ...summaryQueue.snapshot(),
    });
  });

  // ---- Google Maps client config -------------------------------------------
  r.get('/api/maps/config', (c: Context) => {
    const settings = getAppSettings(db);
    const key = settings['maps.api_key'] || process.env.GOOGLE_MAPS_API_KEY || '';
    return c.json({ apiKey: key, hasKey: !!key });
  });

  r.patch('/api/maps/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { apiKey?: unknown };
    if (typeof body.apiKey !== 'string') {
      return c.json({ error: 'apiKey (string) required' }, 400);
    }
    setAppSettings(db, { 'maps.api_key': body.apiKey.trim() });
    return c.json({ ok: true });
  });

  // ---- ingest key 管理 (UI 経由) -------------------------------------------
  //
  // 個人ツールなので key 自体は端末/ブラウザ側で確認できる必要がある。
  // GET 系は読みやすいよう preview (先頭 4 + 末尾 4) を返し、 full 値は
  // 1 度きりの「生成直後」response でしか出さない (再表示はクリア + 再生成)。

  r.get('/api/locations/settings', (c: Context) => {
    const key = getIngestKey(db);
    return c.json({
      has_key: !!key,
      key_preview: maskKey(key),
      source: (getAppSettings(db)['locations.ingest_key'] || '').trim()
        ? 'settings'
        : (process.env.LOCATIONS_INGEST_KEY ? 'env' : 'none'),
    });
  });

  r.post('/api/locations/settings/regenerate', (c: Context) => {
    // crypto.randomUUID() の方が読みやすいが Basic auth password にする都合で
    // 32-byte hex の方が typing しやすい (40 文字)。
    const buf = new Uint8Array(20);
    globalThis.crypto.getRandomValues(buf);
    const newKey = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
    setAppSettings(db, { 'locations.ingest_key': newKey });
    return c.json({ key: newKey, key_preview: maskKey(newKey) });
  });

  r.delete('/api/locations/settings/key', (c: Context) => {
    setAppSettings(db, { 'locations.ingest_key': '' });
    return c.json({ ok: true });
  });

  return r;
}
