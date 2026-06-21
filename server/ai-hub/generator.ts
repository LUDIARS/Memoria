// ai-hub — 1 トピックを本記事 (Markdown) に変換する。
// article_write LLM を 1 本呼び、 文体スタイル指示を prompt に同梱する。
// Spec: spec/feature/ai-hub.md §generator.ts / §文体スタイル

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import type { TopicCandidate, ArticleTag } from './types.js';
import { TAG_CATEGORIES } from './types.js';

type Db = BetterSqlite3.Database;

/**
 * article_write prompt に同梱する固定の文体スタイル指示。
 * Spec の「文体スタイル」 節をそのまま埋め込む。
 */
export const ARTICLE_STYLE = `読者は企業の現役エンジニア。専門用語は噛み砕かずそのまま使ってよい (初学者向けの過度な平易化はしない)。与えられた作業内容(source)の事実を実例の起点にし、設計判断の背景・トレードオフ・代替案・落とし穴まで踏み込んで技術的に深く解釈する (長くなってよい)。断定的でややトゲのある (挑発的な) 文体は残すが、初学者向けの砕けた口調 (「〜だぜ」「〜じゃね?」調) は使わない。AI は道具・判断は人間、という視点は保つ。タイトルはカッコ無しのパンチ重視。Markdown の見出し (#, ##)・箇条書き・必要なら \`\`\`コードブロック\`\`\` を使う。Notion 独自記法は使わない。誇張や捏造をせず、source の事実だけを基に書く。`;

export interface WrittenArticle {
  title: string;
  body_md: string;
  tags: ArticleTag[];
}

/** LLM 出力の tags をホワイトリスト category に正規化する。 */
function coerceTags(v: unknown): ArticleTag[] {
  if (!Array.isArray(v)) return [];
  const cats = new Set<string>(TAG_CATEGORIES);
  const out: ArticleTag[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    let category = typeof o.category === 'string' ? o.category.trim() : '';
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!value) continue;
    if (!cats.has(category)) category = 'その他';
    const key = `${category} ${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category, value });
  }
  return out;
}

/** source_refs のリポ名から「プロジェクト」 タグを決定論的に補完する。 */
function projectTagsFromSources(topic: TopicCandidate): ArticleTag[] {
  const repos = new Set<string>();
  for (const s of topic.sourceRefs) {
    if (s.repo && s.repo.trim()) repos.add(s.repo.trim());
  }
  return [...repos].map(value => ({ category: 'プロジェクト', value }));
}

/** LLM タグ + 決定論プロジェクトタグをマージ (重複排除)。 */
function mergeTags(llmTags: ArticleTag[], detTags: ArticleTag[]): ArticleTag[] {
  const out: ArticleTag[] = [];
  const seen = new Set<string>();
  for (const t of [...detTags, ...llmTags]) {
    const key = `${t.category} ${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** LLM 出力 (```json フェンス等) から JSON 配列を抜き出す。 */
function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const tryParse = (s: string): unknown[] | null => {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const arr = tryParse(candidate.slice(start, end + 1));
    if (arr) return arr;
  }
  return [];
}

/**
 * 完成記事 (title + body) から分類タグを抽出する専用の LLM 呼び出し。
 * 長文の本文と同じ JSON に tags を載せると末尾が欠落・壊れやすいため、
 * 短い出力だけを返す独立タスク (haiku) に分離する。 失敗時は空配列。
 */
export async function generateArticleTags(title: string, body: string): Promise<ArticleTag[]> {
  const prompt = [
    'あなたは技術記事に分類タグを付ける司書だ。 以下の記事に 5 分類でタグを付けよ。',
    '各分類は 0〜3 個。 該当が無ければその分類は省略してよい。 記事に明示された事実のみ (推測で増やさない)。',
    '- 言語: プログラミング言語 (TypeScript / C++ / Rust / Python 等)',
    '- プロジェクト: 対象リポ・サービス名 (Memoria / Ergo / Pictor 等)',
    '- 内容タイプ: 作業の性質 (設計 / 開発 / 運用 / テスト / デバッグ / リファクタ / 調査 等)',
    '- 技術領域: 扱った領域 (ネットワーク / 描画 / DB / AI / ビルド / UI / 認証 / 並行処理 等)',
    '- その他: 上記に入らない特徴語',
    '',
    `## タイトル\n${title}`,
    `## 本文 (先頭のみ)\n${body.slice(0, 4000)}`,
    '',
    '## 出力形式',
    '次の JSON 配列だけを返せ (前後に説明を付けない):',
    '[{ "category": "言語", "value": "TypeScript" }, { "category": "技術領域", "value": "ネットワーク" }]',
  ].join('\n');

  try {
    const raw = await runLlm({ task: 'article_tags', prompt });
    return coerceTags(extractJsonArray(raw));
  } catch (e) {
    console.warn('[ai-hub generator] generateArticleTags failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * LLM が返した記事 Markdown を整形する。
 * - 全体を ```markdown ... ``` で包んでいたら剥がす
 * - 先頭の見出し `# タイトル` をタイトルとして取り出し、本文からは除去する
 *   (カードはタイトルを別表示するため、本文と二重に出さない)。
 * 見出しが無ければ fallbackTitle を使い、本文はそのまま。
 *
 * article_write は当初 {title, body_md} の JSON で返させていたが、本文に
 * ```コードブロック``` が入ると JSON フェンス抽出・パースが壊れて raw JSON が
 * そのまま本文に入る不具合が出たため、プレーン Markdown 出力に変更した。
 */
function parseMarkdownArticle(raw: string, fallbackTitle: string): { title: string; body_md: string } {
  let md = raw.trim();
  const wrap = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(md);
  if (wrap) md = wrap[1].trim();

  const lines = md.split('\n');
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  const h1 = idx < lines.length ? /^#\s+(.+?)\s*#*$/.exec(lines[idx].trim()) : null;
  let title = fallbackTitle;
  if (h1) {
    title = h1[1].trim();
    lines.splice(idx, 1);
  }
  const body = lines.join('\n').trim();
  return { title, body_md: body || md };
}

/**
 * 1 トピックを本記事化する。 LLM には文体スタイル + トピック情報 + 出所事実を
 * 渡し、 プレーン Markdown (先頭 `# タイトル`) で返させる。 タグは完成記事から
 * 専用 LLM (article_tags) で別途抽出し、 プロジェクトは source_refs から決定論補完。
 */
export async function writeArticle(_db: Db, topic: TopicCandidate): Promise<WrittenArticle> {
  const sourceFacts = topic.sourceRefs.length
    ? topic.sourceRefs.map((s) => `- ${s.kind}${s.repo ? ` (${s.repo})` : ''}: ${s.ref}`).join('\n')
    : '(出所参照なし — 与えられた要約とアングルの範囲で書く)';

  const prompt = [
    'あなたはゲーム開発の技術記事ライターだ。 以下のトピックを 1 本の技術記事にする。',
    '',
    '## 文体スタイル (厳守)',
    ARTICLE_STYLE,
    '',
    '## トピック',
    `タイトル案: ${topic.title}`,
    `要約 (なぜ記事になるか): ${topic.summary}`,
    `提案アングル: ${topic.angle}`,
    '',
    '## 出所 (この事実だけを根拠にする。 捏造禁止)',
    sourceFacts,
    '',
    '## 出力形式 (厳守)',
    '記事本文だけをプレーンな Markdown で出力する。 JSON にしない。 前後に説明文を付けない。',
    '1 行目を `# 記事タイトル` (H1) にし、 2 行目以降に本文を書く。',
    '本文中のコード例は ```言語 ... ``` のコードブロックで書いてよい (出力全体を ``` で包まない)。',
  ].join('\n');

  const raw = await runLlm({ task: 'article_write', prompt });
  const detTags = projectTagsFromSources(topic);
  const { title, body_md } = parseMarkdownArticle(raw, topic.title);
  const safeBody = body_md.trim() || `# ${topic.title}\n\n(本文生成に失敗しました)`;
  const llmTags = body_md.trim() ? await generateArticleTags(title, safeBody) : [];
  return { title, body_md: safeBody, tags: mergeTags(llmTags, detTags) };
}

/**
 * 旧 JSON 出力時代に「raw JSON がそのまま body_md に入った」記事を救済する。
 * body_md が `{...,"body_md":"..."}` 形式なら内側の Markdown を取り出し、
 * 先頭 H1 をタイトルとして分離して返す。 プレーン Markdown ならば null。
 */
export function repairArticleBody(storedBody: string, fallbackTitle: string): { title: string; body_md: string } | null {
  const t = storedBody.trim();
  if (!t.startsWith('{')) return null; // すでにプレーン Markdown
  let inner: string | null = null;
  let innerTitle = '';
  try {
    const obj = JSON.parse(t) as { title?: unknown; body_md?: unknown };
    if (obj && typeof obj.body_md === 'string' && obj.body_md.trim()) {
      inner = obj.body_md;
      if (typeof obj.title === 'string' && obj.title.trim()) innerTitle = obj.title.trim();
    }
  } catch {
    // 末尾の `"body_md":"..."}` を緩く抜き出して JSON 文字列としてデコードする。
    const m = /"body_md"\s*:\s*"([\s\S]*)"\s*\}\s*$/.exec(t);
    if (m) { try { inner = JSON.parse(`"${m[1]}"`) as string; } catch { inner = null; } }
  }
  if (inner == null) return null;
  return parseMarkdownArticle(inner, innerTitle || fallbackTitle);
}
