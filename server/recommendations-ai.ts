// AI 主導おすすめパイプライン。
//
// おすすめを **2 軸** で評価する (2026-06-23 改訂):
//   軸A「停滞分析→打開情報」: ユーザ自身の活動 6 領域 (ブラウザ履歴 / ブクマ /
//     git commit / Claude prompt / ゲーム / ノート + dig) を直近 1 週間で集計し、
//     「未解決のまま停滞しているテーマ」 と「もう一押しで打開できる情報」 を出す。
//   軸B「ニュースアンテナ→不足コンテンツの補間」: ニュース (RSS 記事) と AI 記事を
//     アンテナとして、 世の中で起きている重要・新出トピックのうち **ユーザがまだ
//     追えていない不足領域** を見つけ、 それを補間するおすすめを出す。
//
// 各領域を Sonnet agent が並列に分析し、 最後に Opus が全 agent の出力を 2 軸で
// 統合してユーザに渡す URL リスト + 理由 (+ どちらの軸か) を出力する。
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
  findRunningRecommendationRun, cancelRunningRecommendationRuns,
  listAiArticles,
  type RecSourceBookmark, type RecBrowserDomain, type RecGitCommit,
  type RecClaudePrompt, type RecGameSummary, type RecAppSummary,
  type RecNoteSummary, type RecDigSummary,
} from './db.js';
import {
  listRecentTopArticles, listEnabledInterests,
  type ArticleWithFeed, type RssInterestRow,
} from './rss/index.js';
import type { AiArticle } from './ai-hub/types.js';
import { runLlm, getLlmConfig } from './llm.js';

type Db = BetterSqlite3.Database;

/** おすすめの評価軸。 軸A=自分の停滞打開 / 軸B=ニュースアンテナの不足補間。 */
export type RecAxis = 'stagnation' | 'news_antenna';

export const REC_AXIS_LABELS: Record<RecAxis, string> = {
  stagnation:   '停滞打開',
  news_antenna: '不足補間',
};

export type RecAgentKind =
  // 軸A: 停滞分析 (ユーザ自身の活動)
  | 'browser_history' | 'bookmarks' | 'git_commits'
  | 'claude_prompts' | 'games_apps' | 'notes_digs'
  // 軸B: ニュースアンテナ (外界の新出情報)
  | 'news' | 'ai_articles';

export const REC_AGENT_KINDS: RecAgentKind[] = [
  'browser_history', 'bookmarks', 'git_commits',
  'claude_prompts', 'games_apps', 'notes_digs',
  'news', 'ai_articles',
];

const REC_AGENT_LABELS: Record<RecAgentKind, string> = {
  browser_history: 'ブラウザ履歴',
  bookmarks:       'ブクマ',
  git_commits:     'git commit',
  claude_prompts:  'Claude prompt',
  games_apps:      'ゲーム / アプリ',
  notes_digs:      'ノート + Dig',
  news:            'ニュース',
  ai_articles:     'AI 記事',
};

/** 各エージェント領域がどちらの軸に属するか。 */
const REC_AGENT_AXIS: Record<RecAgentKind, RecAxis> = {
  browser_history: 'stagnation',
  bookmarks:       'stagnation',
  git_commits:     'stagnation',
  claude_prompts:  'stagnation',
  games_apps:      'stagnation',
  notes_digs:      'stagnation',
  news:            'news_antenna',
  ai_articles:     'news_antenna',
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
  /** どちらの軸由来のおすすめか。 'stagnation'=停滞打開 / 'news_antenna'=不足補間。 */
  axis: RecAxis;
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
  axis: RecAxis;
  label: string;
  inputSummary: string;
  prompt: string;
}

function buildAgentJobs(db: Db): AgentJob[] {
  // ── 軸A: 停滞分析 (ユーザ自身の活動) ──────────────────────────────────────
  const browser = recBrowserHistory(db, SINCE_DAYS, 30);
  const bookmarks = recRecentBookmarks(db, SINCE_DAYS, 40);
  const commits = recGitCommits(db, SINCE_DAYS, 80);
  const prompts = recClaudePrompts(db, SINCE_DAYS, 80);
  const games = recGamesLastWeek(db, SINCE_DAYS, 20);
  const apps = recAppsLastWeek(db, SINCE_DAYS, 25);
  const notes = recRecentNotes(db, SINCE_DAYS, 25);
  const digs = recRecentDigs(db, SINCE_DAYS, 20);

  // ── 軸B: ニュースアンテナ (外界の新出情報) ────────────────────────────────
  const news = listRecentTopArticles(db, 72, 30);
  const aiArticles = listAiArticles(db, 20);
  const interests = listEnabledInterests(db);
  // 軸B が「ユーザに不足しているもの」 を判定するための、 ユーザの関心・作業領域サマリ。
  const focus = userFocusSummary(interests, commits, notes);

  const jobs: AgentJob[] = [
    {
      kind: 'browser_history',
      axis: REC_AGENT_AXIS.browser_history,
      label: REC_AGENT_LABELS.browser_history,
      inputSummary: `${browser.length} domains`,
      prompt: agentPromptStagnation('ブラウザ履歴', formatBrowser(browser)),
    },
    {
      kind: 'bookmarks',
      axis: REC_AGENT_AXIS.bookmarks,
      label: REC_AGENT_LABELS.bookmarks,
      inputSummary: `${bookmarks.length} bookmarks`,
      prompt: agentPromptStagnation('ブクマ', formatBookmarks(bookmarks)),
    },
    {
      kind: 'git_commits',
      axis: REC_AGENT_AXIS.git_commits,
      label: REC_AGENT_LABELS.git_commits,
      inputSummary: `${commits.length} commits`,
      prompt: agentPromptStagnation('git commit ログ', formatCommits(commits)),
    },
    {
      kind: 'claude_prompts',
      axis: REC_AGENT_AXIS.claude_prompts,
      label: REC_AGENT_LABELS.claude_prompts,
      inputSummary: `${prompts.length} prompts`,
      prompt: agentPromptStagnation('Claude Code プロンプト履歴', formatPrompts(prompts)),
    },
    {
      kind: 'games_apps',
      axis: REC_AGENT_AXIS.games_apps,
      label: REC_AGENT_LABELS.games_apps,
      inputSummary: `${games.length} games / ${apps.length} apps`,
      prompt: agentPromptStagnation(
        'ゲーム / アプリ利用ログ',
        formatGames(games) + '\n\n' + formatApps(apps),
      ),
    },
    {
      kind: 'notes_digs',
      axis: REC_AGENT_AXIS.notes_digs,
      label: REC_AGENT_LABELS.notes_digs,
      inputSummary: `${notes.length} notes / ${digs.length} digs`,
      prompt: agentPromptStagnation(
        '最近書いたノート + Dig (深掘り検索) ログ',
        formatNotes(notes) + '\n\n' + formatDigs(digs),
      ),
    },
    {
      kind: 'news',
      axis: REC_AGENT_AXIS.news,
      label: REC_AGENT_LABELS.news,
      inputSummary: `${news.length} articles`,
      prompt: agentPromptAntenna('ニュース記事 (RSS / トレンド)', formatNews(news), focus),
    },
    {
      kind: 'ai_articles',
      axis: REC_AGENT_AXIS.ai_articles,
      label: REC_AGENT_LABELS.ai_articles,
      inputSummary: `${aiArticles.length} ai-articles`,
      prompt: agentPromptAntenna('AI 記事 (自動生成のナレッジ記事)', formatAiArticles(aiArticles), focus),
    },
  ];
  return jobs;
}

/** 軸B のアンテナ agent がギャップ判定に使う、 ユーザの関心・作業領域の短いサマリ。 */
function userFocusSummary(
  interests: RssInterestRow[],
  commits: RecGitCommit[],
  notes: RecNoteSummary[],
): string {
  const interestLabels = interests.map(i => i.label).filter(Boolean).slice(0, 20);
  const repos = Array.from(new Set(commits.map(c => c.source).filter(Boolean))).slice(0, 15);
  const noteTitles = notes.map(n => n.title).filter(Boolean).slice(0, 12);
  const lines: string[] = [];
  if (interestLabels.length) lines.push(`関心テーマ: ${interestLabels.join(' / ')}`);
  if (repos.length) lines.push(`作業中リポ/領域: ${repos.join(' / ')}`);
  if (noteTitles.length) lines.push(`最近のノート: ${noteTitles.join(' / ')}`);
  return lines.length ? lines.join('\n') : '(関心・作業領域の手がかりなし)';
}

/** 軸A: ユーザ自身の活動ログから「停滞テーマ → 打開情報」 を抽出する agent プロンプト。 */
function agentPromptStagnation(kind: string, body: string): string {
  return [
    `あなたは「${kind}」 専門のアナリスト AI です (評価軸: 停滞分析→打開)。`,
    `下記は直近 ${SINCE_DAYS} 日のユーザの ${kind} です。`,
    '',
    body || '(ログなし)',
    '',
    'このログから、 ユーザが **自分で停滞している** ポイントを抽出してください:',
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

/**
 * 軸B: ニュース / AI 記事をアンテナとして「ユーザがまだ追えていない重要トピック
 * (= 不足コンテンツ)」 を抽出する agent プロンプト。 focus にユーザの関心・作業領域を
 * 渡し、 それと照らして「不足している」 ものを判定させる。
 */
function agentPromptAntenna(kind: string, body: string, focus: string): string {
  return [
    `あなたは「${kind}」 を読み解くニュースアンテナ AI です (評価軸: ニュースアンテナ→不足補間)。`,
    '',
    '## ユーザの関心・作業領域 (これと照らして「不足」 を判定する)',
    focus,
    '',
    `## 直近の ${kind}`,
    body || '(記事なし)',
    '',
    '上記の外界情報のうち、 **ユーザの関心・作業領域に関係するのに、 ユーザがまだ',
    '追えていない / 取りこぼしていそうな** 重要・新出トピックを抽出してください。',
    '既にユーザが追えていると思われる話題は除外し、 「不足の補間」 になるものだけ選ぶ。',
    '',
    '出力フォーマット (JSON のみ、 5 件以内):',
    '```json',
    '[',
    '  {',
    '    "topic": "短いタイトル",',
    '    "evidence": "根拠にした記事のタイトルと URL",',
    '    "gap": "なぜこれがユーザの不足領域か (関心はあるが追えていない理由)",',
    '    "suggestion": "これを補間するために読む / 試すと良いこと"',
    '  }',
    ']',
    '```',
    'JSON 以外は出力しないでください。',
  ].join('\n');
}

function synthesisPrompt(agentOutputs: RecAgentLog[]): string {
  const byAxis = (axis: RecAxis) =>
    agentOutputs
      .filter(a => REC_AGENT_AXIS[a.kind] === axis)
      .map((a, i) => [
        `### アナリスト ${i + 1}: ${a.label}`,
        a.error ? `(エラー: ${a.error})` : a.output.slice(0, 5000),
      ].join('\n'))
      .join('\n\n') || '(出力なし)';

  return [
    `あなたは ${REC_AGENT_KINDS.length} 名のアナリストの調査結果を **2 軸** で統合する上位 AI です。`,
    '',
    '## 軸A: 停滞分析 → 打開情報 (ユーザ自身の活動から)',
    byAxis('stagnation'),
    '',
    '## 軸B: ニュースアンテナ → 不足補間 (外界の新出情報から)',
    byAxis('news_antenna'),
    '',
    '## 指示',
    'これらを統合し、 ユーザに渡すおすすめリソース URL を **合計 10 件程度** 選定してください。',
    '**両方の軸をバランス良く** 含めること (どちらかに偏らせない。 目安: 各軸 4〜6 件)。',
    '- 軸A (stagnation): ユーザが停滞しているテーマを「いま読むと打開につながる」 リソース。',
    '- 軸B (news_antenna): ユーザがまだ追えていない重要トピックを補間するリソース。',
    '  軸B はアナリストが挙げた記事の **実 URL** を優先的に使う (実在性が高いため)。',
    'web 上で確実に到達できる安定した URL を優先 (公式ドキュメント / 主要 OSS リポ /',
    '著名 blog / 一次ニュース記事 等)。',
    '',
    '出力フォーマット (JSON のみ):',
    '```json',
    '[',
    '  {',
    '    "url": "https://...",',
    '    "title": "短い見出し",',
    '    "axis": "stagnation",',
    '    "why": "なぜおすすめか、 どの分析を根拠としたかを 2-3 行で",',
    '    "expected_value": "これを見ると何が打開 / 補間できるか",',
    '    "agent_kinds": ["git_commits","news"]',
    '  }',
    ']',
    '```',
    'axis は "stagnation" (停滞打開) か "news_antenna" (不足補間) のいずれか。',
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

function formatNews(items: ArticleWithFeed[]): string {
  if (items.length === 0) return 'ニュース: (記事なし)';
  return items.map(a => {
    const src = a.feed_title ? ` [${a.feed_title}]` : '';
    const when = (a.published_at ?? a.fetched_at ?? '').slice(0, 10);
    const body = (a.ai_summary || a.summary || '').replace(/\s+/g, ' ').slice(0, 200);
    return `- ${when}${src} ${a.title}\n  ${a.url}\n  ${body}`;
  }).join('\n');
}

function formatAiArticles(items: AiArticle[]): string {
  if (items.length === 0) return 'AI 記事: (なし)';
  return items.map(a => {
    const tags = a.tags.length ? ` [${a.tags.map(t => t.value).join(',')}]` : '';
    const when = (a.for_date ?? a.created_at ?? '').slice(0, 10);
    const body = a.body_md.replace(/\s+/g, ' ').slice(0, 200);
    return `- ${when}${tags} ${a.title}\n  ${body}`;
  }).join('\n');
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
  expected_value?: unknown; agent_kinds?: unknown; axis?: unknown;
}

/** agent_kinds から軸を推定 (axis 欠落 / 不正時の fallback)。 既定は stagnation。 */
function inferAxis(kinds: RecAgentKind[]): RecAxis {
  return kinds.some(k => REC_AGENT_AXIS[k] === 'news_antenna') ? 'news_antenna' : 'stagnation';
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
    const axis: RecAxis = r.axis === 'news_antenna' || r.axis === 'stagnation' ? r.axis : inferAxis(kinds);
    out.push({ url, title, why, expected_value, agent_kinds: kinds, axis });
  }
  return out;
}

// ── pipeline ──────────────────────────────────────────────────────────────

// inFlight は「現在キューにある run」 の promise + runId を保持する。
// cancel 時に runId を確定的に DB へ cancelled として書き込みたいので、
// promise だけでなく id も対で持つ。 force = true で新規 run を開始する際
// は abandon (= ポインタを差し替え) する: 旧 promise の処理は走り続けるが、
// completeRecommendationRun の WHERE status='running' で db 上書きされない。
let inFlight: { runId: number; promise: Promise<RecRunResult> } | null = null;

export function isRecommendationsRunning(db: Db): boolean {
  return inFlight !== null || !!findRunningRecommendationRun(db);
}

/**
 * 現在 running の run を強制的に cancelled へ遷移させる。
 * - in-memory inFlight ハンドルをクリア (= 後続の run はブロックされなくなる)
 * - DB の running 行を全て 'cancelled' に更新 (= isRecommendationsRunning 解除)
 *
 * 実際の LLM 呼び出しを中断する手段は持っていないので、 abandon された
 * 旧 run はバックグラウンドで完了するが、 completeRecommendationRun の
 * WHERE status='running' により DB 上書きは行われない。
 */
export function cancelAiRecommendations(db: Db, reason = 'user_cancelled'): { dbCancelled: number; hadInFlight: boolean } {
  const hadInFlight = inFlight !== null;
  inFlight = null;
  const dbCancelled = cancelRunningRecommendationRuns(db, reason);
  return { dbCancelled, hadInFlight };
}

export async function runAiRecommendations(db: Db, options: { force?: boolean } = {}): Promise<RecRunResult> {
  if (inFlight && !options.force) return inFlight.promise;
  if (inFlight && options.force) {
    // 旧 run を abandon。 DB 側も cancelled に倒す。
    cancelAiRecommendations(db, 'superseded_by_force_run');
  } else if (options.force) {
    // inFlight は空でも、 server 再起動で DB に取り残された 'running' がある
    // 可能性がある。 force なら必ず掃除してから始める。
    cancelRunningRecommendationRuns(db, 'superseded_by_force_run');
  }
  const avail = isAiRecommendationsAvailable();
  if (!avail.available) throw new Error(avail.reason);
  const cfg = getLlmConfig();
  const modelSonnet = cfg.tasks.recommendation_agent?.model || 'sonnet';
  const modelOpus = cfg.tasks.recommendation_synthesize?.model || 'claude-opus-4-7[1m]';
  const runId = insertRecommendationRun(db);
  const handle = { runId, promise: undefined as unknown as Promise<RecRunResult> };
  const promise = (async () => {
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
  })().finally(() => {
    // 自分が現役の handle のときだけ clear。 superseded されている場合は
    // 既に inFlight = null か別の run に置き換わっているので触らない。
    if (inFlight && inFlight.runId === runId) inFlight = null;
  });
  handle.promise = promise;
  inFlight = handle;
  return promise;
}
