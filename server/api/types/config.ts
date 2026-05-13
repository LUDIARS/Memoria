// config API request/response types — privacy / llm / tracks / setup-docs
// Spec: spec/api/config.md

// ── プライバシー / 機能 ON/OFF ───────────────────────────────────────────
export interface PrivacySettings {
  tracks_enabled: boolean;
  tracks_visible: boolean;
  meals_enabled: boolean;
  meals_visible: boolean;
  tasks_actio_share_enabled: boolean;
  actio_share_url: string;
  tasks_reminder_enabled: boolean;
  tasks_reminder_hour: number;          // 0-23
  tasks_reminder_minute: number;        // 0-59
  tasks_reminder_nuntius_enabled: boolean;
  tasks_reminder_nuntius_url: string;
  mcp_autostart_enabled: boolean;
  workplace_geo_enabled: boolean;
  workplace_auto_share_enabled: boolean;
  workplace_match_radius_m: number;     // 20-2000m
  workplace_max_speed_kmh: number;      // 0-200, 0=disable speed filter
}

export type PrivacySettingsPatch = Partial<PrivacySettings>;

export interface PrivacySettingsResponse {
  settings: PrivacySettings;
}

// ── LLM 設定 ─────────────────────────────────────────────────────────────
export type LlmProviderKey = 'algorithm' | 'claude' | 'codex' | 'gemini' | 'openai';

export interface LlmTaskConfig {
  provider: LlmProviderKey;
  model?: string;
}

export interface LlmConfigState {
  tasks: Record<string, LlmTaskConfig>;
  bins: { claude: string; gemini: string; codex: string };
  openai_api_key: string;               // GET 時は '***' or '' に masked
  openai_api_key_set?: boolean;
  openai_model: string;
  git_bash_path: string;
  diary_global_memo?: string;
  user_profile?: {
    age: number | null;
    sex: '' | 'male' | 'female';
    weight_kg: number | null;
    height_cm: number | null;
    activity_level: 'low' | 'moderate' | 'high';
  };
}

export interface LlmProviderInfo {
  key: LlmProviderKey;
  label: string;
  kind: 'cli' | 'api' | 'none';
  supportsTools?: boolean;
  supportsModel?: boolean;
}

export interface LlmModelOption {
  id: string;                           // '' = provider default
  label: string;
}

export interface LlmConfigResponse {
  config: LlmConfigState;
  tasks: string[];                      // 既知の task 名
  providers: LlmProviderInfo[];
  provider_models: Partial<Record<LlmProviderKey, LlmModelOption[]>>;
  provider_default_model: Partial<Record<LlmProviderKey, string>>;
  runtime: { port: number; data_dir: string; platform: string };
}

export interface LlmConfigPatch {
  tasks?: Record<string, Partial<LlmTaskConfig>>;
  bins?: Partial<{ claude: string; gemini: string; codex: string }>;
  openai_api_key?: string;
  openai_model?: string;
  git_bash_path?: string;
  diary_global_memo?: string;
  user_profile?: Partial<LlmConfigState['user_profile']>;
}

// ── tracks 描画 ─────────────────────────────────────────────────────────
export interface TracksSettings {
  decimate_meters: number;
  show_polyline: boolean;
}

export type TracksSettingsPatch = Partial<TracksSettings>;

// ── setup-docs ───────────────────────────────────────────────────────────
export interface SetupDocSummary {
  key: string;
  title: string;
}

export interface SetupDoc {
  key: string;
  title: string;
  body: string;                         // markdown
}

export interface SetupDocsListResponse {
  docs: SetupDocSummary[];
}
