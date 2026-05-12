// Application catalog — process_name (= exe 名) 単位で「これは何のアプリ?」 を
// AI に聞いて分類するパス。 domain-catalog と同じデザインで、 1 process_name
// に 1 行、 status='pending' → 'done' (or 'error') に遷移する。
//
// AI 呼び出しは `runLlm({ task: 'app_classify', ... })`。 task name は llm.ts に
// 追加。 prompt は process_name と (任意で) 既知の window_title を渡し、
// JSON で {name, kind, description} を返してもらう。

import { runLlm } from './llm.js';

export type AppKindString =
  | 'game' | 'work' | 'browser' | 'messaging' | 'media' | 'creative' | 'other';

export interface AppClassifyInput {
  processName: string;
  /** 最近観測された window_title (= 名前推定の補助に使う、 空でも OK) */
  recentTitles?: string[];
  /** ユーザの OS (= ヒント; "win32"/"darwin"/"linux") */
  platform?: string;
  /** LLM 呼び出しタイムアウト (default 60s) */
  timeoutMs?: number;
}

export interface AppClassifyResult {
  name: string;
  kind: AppKindString;
  description: string;
}

const PROMPT = (a: AppClassifyInput): string => [
  'あなたは PC アプリケーションを辞書化する係です。 次の情報からこの exe を 1 つの JSON オブジェクトで分類してください (前置き不要、 コードフェンス禁止)。',
  '',
  'スキーマ:',
  '{',
  '  "name": "人間に分かるアプリ名 (例: Visual Studio Code, Discord, バルダーズゲート3)。日本語名があれば優先",',
  '  "kind": "下記 7 種類のいずれか必須: game | work | browser | messaging | media | creative | other",',
  '  "description": "1 文 (40〜100 文字) で「このアプリで何をするか」"',
  '}',
  '',
  'kind の定義 (= ユーザの 1 日の集計に使うので **厳格**に判定):',
  '- game     : ビデオゲーム本体 (Steam ゲーム / スタンドアロン ゲーム / エミュレータ等)',
  '- work     : IDE / ターミナル / Office / 業務ツール / DB クライアント / SSH クライアント等',
  '- browser  : Chrome / Edge / Firefox / Brave 等のブラウザ本体',
  '- messaging: Discord / Slack / Teams / LINE / Skype / Telegram 等',
  '- media    : VLC / Spotify / YouTube アプリ / プレイヤー系',
  '- creative : Photoshop / Illustrator / Blender / DAW / 動画編集 等',
  '- other    : 上記に当てはまらない (= OS 標準 / システム / 分類困難)',
  '',
  '例:',
  '- "Code.exe" → {"name":"Visual Studio Code","kind":"work","description":"プログラミング向けの軽量エディタ。"}',
  '- "BG3.exe"  → {"name":"バルダーズゲート3","kind":"game","description":"Larian Studios のターン制 RPG。"}',
  '- "Discord.exe" → {"name":"Discord","kind":"messaging","description":"友人とのチャット / 通話アプリ。"}',
  '',
  `process_name: ${a.processName}`,
  a.platform ? `platform: ${a.platform}` : '',
  a.recentTitles?.length ? `recent_window_titles:\n${a.recentTitles.slice(0, 3).map((t) => `  - ${t}`).join('\n')}` : '',
  '',
  'JSON のみを 1 行 (改行込みでも可) で返してください。',
].filter(Boolean).join('\n');

const VALID_KINDS = new Set<AppKindString>(['game', 'work', 'browser', 'messaging', 'media', 'creative', 'other']);

export async function classifyApplication(input: AppClassifyInput): Promise<AppClassifyResult> {
  const stdout = await runLlm({ task: 'app_classify', prompt: PROMPT(input), timeoutMs: input.timeoutMs ?? 60_000 });
  const trimmed = stdout.trim();
  // 最初の '{' 〜 最後の '}' をパース対象に
  const a = trimmed.indexOf('{');
  const b = trimmed.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`classify response not JSON: ${trimmed.slice(0, 200)}`);
  const raw = trimmed.slice(a, b + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`classify response JSON parse: ${(e as Error).message} (raw: ${raw.slice(0, 200)})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('classify response not object');
  }
  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const kindRaw = typeof p.kind === 'string' ? p.kind.trim().toLowerCase() : '';
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (!name) throw new Error('classify response missing name');
  const kind: AppKindString = (VALID_KINDS as Set<string>).has(kindRaw) ? (kindRaw as AppKindString) : 'other';
  return { name, kind, description };
}
