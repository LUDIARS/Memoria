// ai-hub — 1 トピックを本記事 (Markdown) に変換する。
// article_write LLM を 1 本呼び、 文体スタイル指示を prompt に同梱する。
// Spec: spec/feature/ai-hub.md §generator.ts / §文体スタイル

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import type { TopicCandidate } from './types.js';

type Db = BetterSqlite3.Database;

/**
 * article_write prompt に同梱する固定の文体スタイル指示。
 * Spec の「文体スタイル」 節をそのまま埋め込む。
 */
export const ARTICLE_STYLE = `読者は専門学校のゲーム開発初学者〜就活生。口語・挑発的・実例ベース。「君」「〜だぜ」「〜じゃね?」を使い、読者に問いを投げる。具体例→抽象原理→実装/行動への落とし込みの順。AI は道具・人間が判断する、という軸を通す。タイトルはカッコ無しのパンチ重視。Markdown の見出し (#, ##) と箇条書き、必要なら \`\`\`コードブロック\`\`\` を使う。Notion 独自記法 (color 属性等) は使わない。誇張や捏造をせず、与えられた作業内容(source)の事実だけを基に書く。`;

export interface WrittenArticle {
  title: string;
  body_md: string;
}

/** LLM の出力 (```json フェンス等を含むことがある) から JSON オブジェクトを抜き出す。 */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // 最初の { 〜 最後の } を試す
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * 1 トピックを本記事化する。 LLM には文体スタイル + トピック情報 + 出所事実を
 * 渡し、 {title, body_md} を JSON で返させる。 JSON 解釈に失敗した場合は raw を
 * 本文として扱い、 タイトルはトピック由来で補う。
 */
export async function writeArticle(_db: Db, topic: TopicCandidate): Promise<WrittenArticle> {
  const sourceFacts = topic.sourceRefs.length
    ? topic.sourceRefs.map((s) => `- ${s.kind}${s.repo ? ` (${s.repo})` : ''}: ${s.ref}`).join('\n')
    : '(出所参照なし — 与えられた要約とアングルの範囲で書く)';

  const prompt = [
    'あなたはゲーム開発の技術記事ライターだ。 以下のトピックを 1 本の技術記事 (Markdown) にする。',
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
    '## 出力形式',
    '次の JSON オブジェクトだけを返せ (前後に説明を付けない):',
    '{ "title": "記事タイトル", "body_md": "記事本文 (Markdown)" }',
  ].join('\n');

  const raw = await runLlm({ task: 'article_write', prompt });
  const parsed = extractJsonObject(raw);

  if (parsed && typeof parsed === 'object') {
    const o = parsed as { title?: unknown; body_md?: unknown; body?: unknown };
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : topic.title;
    const body = typeof o.body_md === 'string' && o.body_md.trim()
      ? o.body_md
      : (typeof o.body === 'string' ? o.body : '');
    if (body.trim()) return { title, body_md: body };
  }

  // JSON 解釈不能 — raw を本文として扱う (空でない限り)。
  const fallbackBody = raw.trim();
  return {
    title: topic.title,
    body_md: fallbackBody || `# ${topic.title}\n\n(本文生成に失敗しました)`,
  };
}
