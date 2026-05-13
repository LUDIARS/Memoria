// AI 主導おすすめパイプライン。
// 6 領域 (ブラウザ履歴 / ブクマ / git commit / Claude prompt / ゲーム / ノート + dig)
// を直近 1 週間で集計し、 各領域を Sonnet agent が並列に分析。 最後に Opus が
// 全 agent の出力を統合してユーザに渡す URL リスト + 理由を出力する。
//
// AI が未設定 (= cfg.tasks.recommendation_agent.provider === 'algorithm') の場合
// は run は走らず、 上位ハンドラが事前に弾く。
//
// 結果は recommendation_runs テーブルに永続化し、 「なぜ・どのようにおすすめしたか」
// を agent_logs_json から後で参照できるようにする。

import type BetterSqlite3 from 'better-sqlite3';
import {
  recRecentBookmarks, recBrowserHistory, recGitCommits, recClaudePrompts,
  recGamesLastWeek, recAppsLastWeek, recRecentNotes, recRecentDigs,
  insertRecommendationRun, completeRecommendationRun, failRecommendationRun,
  findRunningRecommendationRun,
  type RecSourceBookmark, type RecBrowserDomain, type RecGitCommit,
  type RecClaudePrompt, type RecGameSummary, type RecAppSummary,
  type RecNoteSummary, type RecDigSummary,
} from './db.js';
import { runLlm, getLlmConfig } from './llm.js';

type Db = BetterSqlite3.Database;

export type RecAgentKind =
  | 'browser_history' | 'bookmarks' | 'git_commits'
  | 'claude_prompts' | 'games_apps' | 'notes_digs';

export const REC_AGENT_KINDS: RecAgentKind[] = [
  'browser_history', 'bookmarks', 'git_commits',
  'claude_prompts', 'games_apps', 'notes_digs',
];

const REC_AGENT_LABELS: Record<RecAgentKind, string> = {
  browser_history: 'ブラウザ履歴',
  bookmarks:       'ブクマ',
  git_commits:     'git commit',
  claude_prompts:  'Claude prompt',
  games_apps:      'ゲーム / アプリ',
  notes_digs:      'ノート + Dig',
};

const SINCE_DAYS = 7;
const AGENT_TIMEOUT_MS = 3_000_000;

export interface RecAgentLog {
  kind: RecAgentKind;
  label: string;
  input_summary: string;
  output: string;
  error?: string;
}

export interface RecResultItem {
  url: string;
  title: string;
  why: string;
  expected_value: string;
  agent_kinds: RecAgentKind[];
}

export interface RecSynthesisLog {
  input_agent_count: number;
  output: string;
}

export interface RecAgentLogBundle {
  agents: RecAgentLog[];
  synthesis: RecSynthesisLog;
}

export interface RecRunResult {
  runId: number;
  items: RecResultItem[];
  logs: RecAgentLogBundle;
}

export function isAiRecommendationsAvailable(): { available: boolean; reason: string } {
  const cfg = getLlmConfig();
  const a = cfg.tasks.recommendation_agent;
  const b = cfg.tasks.recommendation_synthesize;
  if (!a || a.provider === 'algorithm') return { available: false, reason: 'recommendation_agent が AI に設定されていません' };
  if (!b || b.provider === 'algorithm') return { available: false, reason: 'recommendation_synthesize が AI に設定されていません' };
  if (a.provider === 'openai' && !cfg.openai_api_key) return { available: false, reason: 'OpenAI API key が未設定です' };
  if (b.provider === 'openai' && !cfg.openai_api_key) return { available: false, reason: 'OpenAI API key が未設定です' };
  return { available: true, reason: '' };
}

interface AgentJob {
  kind: RecAgentKind;
  label: string;
  inputSummary: string;
  prompt: string;
}

function buildAgentJobs(db: Db): AgentJob[] {
  const browser = recBrowserHistory(db, SINCE_DAYS, 30);
  const bookmarks = recRecentBookmarks(db, SINCE_DAYS, 40);
  const commits = recGitCommits(db, SINCE_DAYS, 80);
  const prompts = recClaudePrompts(db, SINCE_DAYS, 80);
  const games = recGamesLastWeek(db, SINCE_DAYS, 20);
  const apps = recAppsLastWeek(db, SINCE_DAYS, 25);
  const notes = recRecentNotes(db, SINCE_DAYS, 25);
  const digs = recRecentDigs(db, SINCE_DAYS, 20);

  return [
    {
      kind: 'browser_history',
      label: REC_AGENT_LABELS.browser_history,
      inputSummary: `${browser.length} domains`,
      prompt: agentPrompt('ブラウザ履歴', formatBrowser(browser)),
    },
    {
      kind: 'bookmarks',
      label: REC_AGENT_LABELS.bookmarks,
      inputSummary: `${bookmarks.length} bookmarks`,
      prompt: agentPrompt('ブクマ', formatBookmarks(bookmarks)),
    },
    {
      kind: 'git_commits',
      label: REC_AGENT_LABELS.git_commits,
      inputSummary: `${commits.length} commits`,
      prompt: agentPrompt('git commit ログ', formatCommits(commits)),
    },
    {
      kind: 'claude_prompts',
      label: REC_AGENT_LABELS.claude_prompts,
      inputSummary: `${prompts.length} prompts`,
      prompt: agentPrompt('Claude Code プロンプト履歴', formatPrompts(prompts)),
    },
    {
      kind: 'games_apps',
      label: REC_AGENT_LABELS.games_apps,
      inputSummary: `${games.length} games / ${apps.length} apps`,
      prompt: agentPrompt(
        'ゲーム / アプリ利用ログ',
        formatGames(games) + '\n\n' + formatApps(apps),
      ),
    },
    {
      kind: 'notes_digs',
      label: REC_AGENT_LABELS.notes_digs,
      inputSummary: `${notes.length} notes / ${digs.length} digs`,
      prompt: agentPrompt(
        '最近書いたノート + Dig (深掘り検索) ログ',
        formatNotes(notes) + '\n\n' + formatDigs(digs),
      ),
    },
  ];
}

function agentPrompt(kind: string, body: string): string {
  return [
    `あなたは「${kind}」 専門のアナリスト AI です。`,
    `下記は直近 ${SINCE_DAYS} 日のユーザの ${kind} です。`,
    '',
    body || '(ログなし)',
    '',
    'このログから以下を抽出してください:',
    '1. ユーザが「未解決のまま放置している」 と思われる調査トピック',
    '2. 関心が高まっている領域 / 繰り返し触れているテーマ',
    '3. 技術的・専門的に「もう一押し調べると突破できそう」 なポイント',
    '',
    '出力フォーマット (JSON のみ、 5 件以内):',
    '```json',
    '[',
    '  {',
    '    "topic": "短いタイトル",',
    '    "evidence": "ログから抽出した具体的根拠 (URL / commit / file 等)",',
    '    "gap": "現状不足している情報",',
    '    "suggestion": "次に調べる / 試すと良いこと"',
    '  }',
    ']',
    '```',
    'JSON 以外は出力しないでください。',
  ].join('\n');
}

function synthesisPrompt(agentOutputs: RecAgentLog[]): string {
  const sections = agentOutputs.map((a, i) => {
    return [
      `## アナリスト ${i + 1}: ${a.label}`,
      a.error ? `(エラー: ${a.error})` : a.output.slice(0, 6000),
    ].join('\n');
  }).join('\n\n');
  return [
    'あなたは 6 名のアナリストの調査結果を統合する上位 AI です。',
    `下記は ${REC_AGENT_KINDS.length} 名のアナリストの出力です。`,
    '',
    sections,
    '',
    'これら全領域を横断的に統合し、 ユーザが「いま読むと打開につながる」',
    'リソース URL を 10 件選定してください。 既知 / 未知 どちらでも構いません。',
    'web 上で確実に到達できる安定した URL を優先してください (= 公式ドキュメント /',
    '主要 OSS リポ / 著名 blog 等)。',
    '',
    '出力フォーマット (JSON のみ):',
    '```json',
    '[',
    '  {',
    '    "url": "https://...",',
    '    "title": "短い見出し",',
    '    "why": "なぜおすすめか、 どの分析を根拠としたかを 2-3 行で",',
    '    "expected_value": "これを見ると何が打開できるか",',
    '    "agent_kinds": ["browser_history","git_commits"]',
    '  }',
    ']',
    '```',
    'agent_kinds は以下のいずれか (複数可):',
    REC_AGENT_KINDS.map(k => `  - ${k}`).join('\n'),
    '',
    'JSON 以外は出力しないでください。',
  ].join('\n');
}

// ── formatters ────────────────────────────────────────────────────────────

function formatBrowser(items: RecBrowserDomain[]): string {
  return items.map(d =>
    `- ${d.domain}  (${d.visits} visits, last ${d.last_seen_at})  titles: ${d.sample_titles.join(' | ').slice(0, 200)}`
  ).join('\n');
}

function formatBookmarks(items: RecSourceBookmark[]): string {
  return items.map(b => {
    const cats = b.categories.length ? ` [${b.categories.join(',')}]` : '';
    const memo = b.memo ? ` memo=${b.memo.slice(0, 80)}` : '';
    return `- ${b.created_at}${cats} ${b.title}\n  ${b.url}\n  ${(b.summary || '').slice(0, 200)}${memo}`;
  }).join('\n');
}

function formatCommits(items: RecGitCommit[]): string {
  return items.map(c =>
    `- ${c.occurred_at} [${c.source ?? '?'}] ${c.content.split('\n')[0].slice(0, 200)}`
  ).join('\n');
}

function formatPrompts(items: RecClaudePrompt[]): string {
  return items.map(p =>
    `- ${p.occurred_at} [${p.source ?? '?'}] ${p.content.slice(0, 300).replace(/\s+/g, ' ')}`
  ).join('\n');
}

function formatGames(items: RecGameSummary[]): string {
  if (items.length === 0) return 'ゲーム: (ログなし)';
  return 'ゲーム:\n' + items.map(g =>
    `- ${g.name} (appid=${g.appid})  ${g.minutes_7d} min in last 7d, last=${g.last_played_at}`
  ).join('\n');
}

function formatApps(items: RecAppSummary[]): string {
  if (items.length === 0) return 'アプリ: (ログなし)';
  return 'アプリ:\n' + items.map(a =>
    `- ${a.app_name ?? a.process_name} [${a.kind ?? '?'}]  ${a.minutes_7d} min  titles: ${a.sample_titles.slice(0, 3).join(' | ').slice(0, 200)}`
  ).join('\n');
}

function formatNotes(items: RecNoteSummary[]): string {
  if (items.length === 0) return 'ノート: (なし)';
  return 'ノート:\n' + items.map(n =>
    `- ${n.updated_at} [${n.kind}] ${n.title}\n  ${n.preview.replace(/\n/g, ' ').slice(0, 300)}`
  ).join('\n');
}

function formatDigs(items: RecDigSummary[]): string {
  if (items.length === 0) return 'Dig: (なし)';
  return 'Dig (深掘り検索):\n' + items.map(d =>
    `- ${d.created_at} [${d.status}] ${d.query}\n  ${d.result_preview.replace(/\s+/g, ' ').slice(0, 300)}`
  ).join('\n');
}

// ── parsers ───────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  if (!text) return null;
  // ```json ... ``` フェンスを優先
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  // 先頭の [ から最後の ] までを抽出 (= fence なし時のフォールバック)
  const first = text.indexOf('[');
  const last  = text.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* keep trying */ }
  }
  return null;
}

interface SynthesizedItem {
  url?: unknown; title?: unknown; why?: unknown;
  expected_value?: unknown; agent_kinds?: unknown;
}

function parseSynthesisItems(raw: string): RecResultItem[] {
  const json = extractJson(raw);
  if (!Array.isArray(json)) return [];
  const out: RecResultItem[] = [];
  for (const r of json as SynthesizedItem[]) {
    if (!r || typeof r !== 'object') continue;
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!/^https?:\/\//.test(url)) continue;
    const title = typeof r.title === 'string' ? r.title.trim() : url;
    const why = typeof r.why === 'string' ? r.why.trim() : '';
    const expected_value = typeof r.expected_value === 'string' ? r.expected_value.trim() : '';
    const kinds = Array.isArray(r.agent_kinds) ? r.agent_kinds.filter(k => REC_AGENT_KINDS.includes(k as RecAgentKind)) as RecAgentKind[] : [];
    out.push({ url, title, why, expected_value, agent_kinds: kinds });
  }
  return out;
}

// ── pipeline ──────────────────────────────────────────────────────────────

let inFlight: Promise<RecRunResult> | null = null;

export function isRecommendationsRunning(db: Db): boolean {
  return inFlight !== null || !!findRunningRecommendationRun(db);
}

export async function runAiRecommendations(db: Db): Promise<RecRunResult> {
  if (inFlight) return inFlight;
  const avail = isAiRecommendationsAvailable();
  if (!avail.available) throw new Error(avail.reason);
  inFlight = (async () => {
    const cfg = getLlmConfig();
    const modelSonnet = cfg.tasks.recommendation_agent?.model || 'sonnet';
    const modelOpus = cfg.tasks.recommendation_synthesize?.model || 'claude-opus-4-7[1m]';
    const runId = insertRecommendationRun(db);
    try {
      const jobs = buildAgentJobs(db);
      const agentLogs: RecAgentLog[] = await Promise.all(jobs.map(async (j): Promise<RecAgentLog> => {
        try {
          const out = await runLlm({ task: 'recommendation_agent', prompt: j.prompt, timeoutMs: AGENT_TIMEOUT_MS });
          return { kind: j.kind, label: j.label, input_summary: j.inputSummary, output: out };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: j.kind, label: j.label, input_summary: j.inputSummary, output: '', error: msg };
        }
      }));

      const synthesized = await runLlm({
        task: 'recommendation_synthesize',
        prompt: synthesisPrompt(agentLogs),
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      const items = parseSynthesisItems(synthesized);
      const logs: RecAgentLogBundle = {
        agents: agentLogs,
        synthesis: { input_agent_count: agentLogs.length, output: synthesized },
      };
      completeRecommendationRun(db, runId, {
        agentLogs: logs,
        results: items,
        modelSonnet,
        modelOpus,
      });
      return { runId, items, logs };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      failRecommendationRun(db, runId, msg);
      throw e;
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}
