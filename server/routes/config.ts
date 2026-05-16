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
  packetmon: {
    title: '🛡 パケット監視の起動方法',
    body: [
      '# 🛡 パケット監視の起動方法',
      '',
      'Memoria の「🛡 パケット監視」タブは、 ローカル PC で走っている外部ツール tools/PacketMonitor が書いている raw.tsv を読んで表示します。 capture 自体は Memoria では起こしません — 先にこの手順で外部 tshark を起動してください。',
      '',
      '## 前提',
      '',
      '- Windows 10 / 11',
      '- Wireshark + Npcap (winget で `WiresharkFoundation.Wireshark` を install)',
      '- PowerShell 5.1+ (Windows 標準)',
      '',
      'スクリプト一式は `E:\\Document\\Ars\\PacketMonitor\\` に置いてあります。 他のパスにある場合は環境変数 `MEMORIA_PACKETMON_LOG_ROOT` で logs ディレクトリを指してください。',
      '',
      '## 1. 監視開始 (アダプタ別)',
      '',
      '```',
      'powershell -File "E:\\Document\\Ars\\PacketMonitor\\start-monitor.ps1"',
      '```',
      '',
      'IPv4 が振られているアダプタごとに tshark を 1 プロセス spawn し、 `logs\\<adapter>\\raw.tsv` に 1 パケット 1 行で TSV を append します。 出力フィールドは:',
      '',
      '- `frame.time_epoch` / `_ws.col.Protocol`',
      '- `ip.src` / `ip.dst` / `tcp.srcport` / `tcp.dstport` / `udp.srcport` / `udp.dstport`',
      '- `tls.handshake.extensions_server_name` (= TLS SNI = どこへ繋ぐ宣言)',
      '- `http.host` (= 平文 HTTP の Host ヘッダ)',
      '- `dns.qry.name` (= DNS query 名)',
      '',
      '## 2. Memoria 側の表示',
      '',
      'Memoria のメインタブ「🛡 パケット監視」 を開くと、 アダプタごとに OUTBOUND (どこへ・何を渡しているか) と INBOUND (どこから来ているか、 逆引きあり) のサマリが出ます。 期間 / 上位件数 / 逆引き ON/OFF は画面上部で切替。',
      '',
      '## 3. 監視停止',
      '',
      '```',
      'powershell -File "E:\\Document\\Ars\\PacketMonitor\\stop-monitor.ps1"',
      '```',
      '',
      'pid ファイル (`logs\\.monitor-state.json`) を読んで該当 tshark プロセスだけ停止します。',
      '',
      '## 4. プロセス紐付け (任意・Sysmon)',
      '',
      'パケットだけでは「どのプロセスが」 は取れません。 PID × 接続先まで欲しい時は Sysmon を入れます:',
      '',
      '```',
      'winget install --id Microsoft.Sysinternals.Sysmon --exact --accept-package-agreements --accept-source-agreements',
      'powershell -Command "Start-Process sysmon -ArgumentList \'-accepteula\',\'-i\',\'E:\\Document\\Ars\\PacketMonitor\\sysmon-config.xml\' -Verb RunAs -Wait"',
      '```',
      '',
      'config は NetworkConnect (Event 3) + DnsQuery (Event 22) のみを拾う最小構成です。 集計は:',
      '',
      '```',
      'powershell -File "E:\\Document\\Ars\\PacketMonitor\\sysmon-tail.ps1" -SinceMinutes 5 -TopN 20',
      '```',
      '',
      '## 5. 環境変数 (override)',
      '',
      '- `MEMORIA_PACKETMON_LOG_ROOT` — logs root を別パスに置く場合に指定。 未設定なら `E:\\Document\\Ars\\PacketMonitor\\logs` → `%USERPROFILE%\\Document\\Ars\\PacketMonitor\\logs` の順に探します。',
      '',
      '## 注意',
      '',
      '- Memoria は raw.tsv を「読むだけ」 で、 個人データの DB 保存はしません。',
      '- 同時書込み中のファイルを読むので、 開いた直後のサマリは「直近 32 MiB」 だけを対象にしています (= 巨大化したログでも応答時間を保つため)。',
      '- Tailscale (wintun) や vEthernet (Hyper-V vSwitch) は Npcap で見えないため、 アダプタ列挙には出ません。 物理 NIC を通る WireGuard UDP として観測できます。',
    ].join('\n'),
  },
};

export interface ConfigRouterDeps {
  db: Db;
  port: number;
  dataDir: string;
  /** privacy.mcp_autostart_enabled が変更されたら呼ばれる */
  onMcpAutostartChange: (enabled: boolean) => void;
  /** activity (app sampling / steam) フラグが変更されたら sampler を再構成 */
  onActivitySettingsChange: () => void;
  // 全 queue の snapshot を返すために必要
  summaryQueue: FifoQueue;
  cloudQueue: FifoQueue;
  digQueue: FifoQueue;
  diaryQueue: FifoQueue;
  weeklyQueue: FifoQueue;
  domainCatalogQueue: FifoQueue;
  pageMetadataQueue: FifoQueue;
  mealVisionQueue: FifoQueue;
  /** AI 分析系の一般 queue (packet-monitor identify-with-ai / identify-process など) */
  aiAnalysisQueue?: FifoQueue;
}

export function makeConfigRouter(deps: ConfigRouterDeps): Hono {
  const {
    db, port, dataDir, onMcpAutostartChange, onActivitySettingsChange,
    summaryQueue, cloudQueue, digQueue, diaryQueue, weeklyQueue,
    domainCatalogQueue, pageMetadataQueue, mealVisionQueue, aiAnalysisQueue,
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
      ['legatus_enabled', 'features.legatus.enabled'],
      ['bookmarks_auto_summarize', 'features.bookmarks.auto_summarize'],
      ['page_metadata_auto_fetch', 'features.page_metadata.auto_fetch'],
      ['domain_catalog_auto_classify', 'features.domain_catalog.auto_classify'],
      ['meals_auto_vision', 'features.meals.auto_vision'],
      ['diary_auto_generate', 'features.diary.auto_generate'],
      ['activity_app_sampling_enabled', 'features.activity.app_sampling.enabled'],
      ['activity_steam_enabled', 'features.activity.steam.enabled'],
    ] as const) {
      if (typeof body[bodyKey] === 'boolean') patch[settingKey] = body[bodyKey] ? '1' : '0';
    }
    if (typeof body.actio_share_url === 'string') patch['actio.share_url'] = body.actio_share_url.trim();
    if (typeof body.tasks_reminder_hour === 'number') patch['features.tasks.reminder.hour'] = String(Math.max(0, Math.min(23, Math.floor(body.tasks_reminder_hour))));
    if (typeof body.tasks_reminder_minute === 'number') patch['features.tasks.reminder.minute'] = String(Math.max(0, Math.min(59, Math.floor(body.tasks_reminder_minute))));
    if (typeof body.tasks_reminder_nuntius_url === 'string') patch['features.tasks.reminder.nuntius_url'] = body.tasks_reminder_nuntius_url.trim();
    if (typeof body.workplace_match_radius_m === 'number') patch['features.workplace.match.radius_m'] = String(Math.max(20, Math.min(2000, Math.floor(body.workplace_match_radius_m))));
    if (typeof body.workplace_max_speed_kmh === 'number') patch['features.workplace.max_speed_kmh'] = String(Math.max(0, Math.min(200, body.workplace_max_speed_kmh)));
    if (Object.keys(patch).length) setAppSettings(db, patch);
    if (Object.prototype.hasOwnProperty.call(body, 'mcp_autostart_enabled')) {
      onMcpAutostartChange(privacySettings(db).mcp_autostart_enabled);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'activity_app_sampling_enabled')
      || Object.prototype.hasOwnProperty.call(body, 'activity_steam_enabled')
    ) {
      onActivitySettingsChange();
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
      // AI 分析系 (= ユーザ操作で起こす identify-with-ai / identify-process 等)
      ai_analysis: aiAnalysisQueue ? aiAnalysisQueue.snapshot() : { depth: 0, running: false, items: [], history: [] },
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

  // gcloud から既存の API key を引き当てて自動セットする補助エンドポイント。
  // 仕様:
  //   1. `gcloud services api-keys list --format=json` で active key を列挙
  //   2. Maps JavaScript API (maps-backend.googleapis.com) に restrict された
  //      key を優先、 無ければ無制限 (restrictions 無し) の key、 最後にどれか 1 つ
  //   3. `gcloud services api-keys get-key-string <name> --format=json` で
  //      生 key 文字列を取得 → app_settings に保存して返却
  // 失敗時の理由 (`reason` フィールド):
  //   - not_installed : gcloud CLI が PATH に無い
  //   - not_authenticated : `gcloud auth list` で active account 無し
  //   - no_project : active project 未設定
  //   - no_keys : list が空
  //   - no_string : get-key-string が key を返さない (権限不足等)
  //   - exec_failed : 通常の exec エラー (stderr を error に格納)
  r.post('/api/maps/config/auto-fetch', async (c: Context) => {
    const { spawn } = await import('node:child_process');
    type Run = { code: number; stdout: string; stderr: string };
    const run = (args: string[]): Promise<Run> => new Promise((resolve) => {
      const child = spawn('gcloud', args, { shell: process.platform === 'win32' });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (b) => { stdout += String(b); });
      child.stderr.on('data', (b) => { stderr += String(b); });
      child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e) }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

    const probe = await run(['--version']);
    if (probe.code !== 0) {
      // probe.stderr は Windows cmd.exe だと Shift-JIS で返ってきて mojibake になる。
      // 何が起きたかは reason から明確なので生 stderr は捨てる。
      return c.json({ ok: false, reason: 'not_installed', error: 'gcloud CLI が PATH に見つかりません' }, 200);
    }

    const auth = await run(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
    if (auth.code !== 0 || !auth.stdout.trim()) {
      return c.json({ ok: false, reason: 'not_authenticated', error: 'gcloud auth login が必要です' }, 200);
    }
    const project = await run(['config', 'get-value', 'project']);
    const projectId = project.stdout.trim();
    if (!projectId || projectId === '(unset)') {
      return c.json({ ok: false, reason: 'no_project', error: '`gcloud config set project <PROJECT_ID>` で active project を設定してください' }, 200);
    }

    const list = await run(['services', 'api-keys', 'list', '--format=json']);
    if (list.code !== 0) {
      return c.json({ ok: false, reason: 'exec_failed', error: list.stderr.trim() || 'list failed' }, 200);
    }
    interface ApiKeyEntry { name?: string; displayName?: string; restrictions?: { apiTargets?: { service?: string }[] } }
    let keys: ApiKeyEntry[] = [];
    try { keys = JSON.parse(list.stdout) as ApiKeyEntry[]; } catch { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) {
      return c.json({ ok: false, reason: 'no_keys', error: 'project にまだ API key がありません', project: projectId }, 200);
    }
    const mapsLike = (e: ApiKeyEntry) => (e.restrictions?.apiTargets ?? []).some(
      (t) => typeof t.service === 'string' && /maps|geocoding|geolocation|places/i.test(t.service),
    );
    const noRestriction = (e: ApiKeyEntry) => !e.restrictions?.apiTargets || e.restrictions.apiTargets.length === 0;
    const pick = keys.find(mapsLike) ?? keys.find(noRestriction) ?? keys[0];
    if (!pick?.name) {
      return c.json({ ok: false, reason: 'no_keys', error: '使える key を抽出できませんでした', project: projectId }, 200);
    }

    const str = await run(['services', 'api-keys', 'get-key-string', pick.name, '--format=value(keyString)']);
    const apiKey = str.stdout.trim();
    if (str.code !== 0 || !apiKey) {
      return c.json({ ok: false, reason: 'no_string', error: str.stderr.trim() || 'keyString を取得できませんでした', project: projectId, picked: pick.displayName ?? pick.name }, 200);
    }
    setAppSettings(db, { 'maps.api_key': apiKey });
    return c.json({ ok: true, apiKey, project: projectId, picked: pick.displayName ?? pick.name });
  });

  // ---- server runtime info (= Tutorial / 拡張連携で「ローカル接続先 URL」 を
  // 動的に出すための軽量 endpoint。 /api/llm/config の runtime と内容は同じだが
  // LLM config を引かなくて済むので拡張インストール画面用に切り出す)。
  r.get('/api/server/info', (c: Context) => {
    return c.json({
      port,
      // Chrome 拡張は PC 内の Memoria に loopback 接続する想定。 Tailscale や
      // Cloudflare Tunnel 経由でアクセス中でも拡張が指すべき URL は localhost。
      extension_url: `http://localhost:${port}`,
      data_dir: dataDir,
      platform: process.platform,
    });
  });

  // ---- 起動チュートリアル状態 (= 「はじめての Memoria」 wizard) ---------
  //
  // 初回起動時にウェルカム wizard を出すための flag。 設定 → AI / モデル の
  // 「🎓 はじめての Memoria を表示」 ボタンで reset 可。 個別のステップで進めた
  // ことを記録する必要は今のところ無く、 完了タイムスタンプだけで十分。

  r.get('/api/tutorial/status', (c: Context) => {
    const s = getAppSettings(db);
    const completedAt = s['tutorial.completed_at'] || '';
    return c.json({
      completed: !!completedAt,
      completed_at: completedAt || null,
    });
  });

  r.post('/api/tutorial/complete', (c: Context) => {
    setAppSettings(db, { 'tutorial.completed_at': new Date().toISOString() });
    return c.json({ ok: true });
  });

  r.post('/api/tutorial/reset', (c: Context) => {
    setAppSettings(db, { 'tutorial.completed_at': '' });
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
