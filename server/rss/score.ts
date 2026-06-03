// 記事 × ユーザの興味テーマ を AI で照合し 0.0-1.0 のスコアを付ける。
// = Feedly Leo / 「自分専用 Discover」 の中核。
//
// 興味テーマが 1 件も無いときはスコアリングせず status='skip'。
// その場合フィードは公開日時順 (=普通の RSS リーダー) で見られる。

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import {
  listEnabledInterests, setArticleScore, getArticle,
} from './store.js';
import type { RssArticleRow, RssInterestRow } from './types.js';

type Db = BetterSqlite3.Database;

function buildPrompt(article: RssArticleRow, interests: RssInterestRow[]): string {
  const themes = interests
    .map((it, i) => `${i + 1}. 「${it.label}」 — ${it.prompt}`)
    .join('\n');
  return [
    'あなたはユーザ専用のニュースキュレーターです。',
    '以下の「興味テーマ」に対して、 記事がどれだけ合致するかを 0.0〜1.0 で採点してください。',
    '',
    '# ユーザの興味テーマ',
    themes,
    '',
    '# 採点する記事',
    `タイトル: ${article.title}`,
    article.summary ? `要約: ${article.summary}` : '要約: (なし)',
    '',
    '# 出力形式',
    '次の JSON だけを返してください (前後に説明文を付けない):',
    '{"score": 0.0, "matched": "最も合致したテーマのlabel または null", "reason": "なぜそのスコアか日本語1文"}',
    '- score: いずれのテーマにも合致しなければ 0.0 に近く、 強く合致すれば 1.0 に近く。',
    '- reason は 60 字以内。',
  ].join('\n');
}

function extractJson(raw: string): { score: number; matched: string | null; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; matched?: unknown; reason?: unknown };
    const score = Number(o.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.min(1, Math.max(0, score)),
      matched: typeof o.matched === 'string' && o.matched.trim() ? o.matched.trim().slice(0, 80) : null,
      reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

/** 1 記事をスコアリングして DB に反映。 戻り値は付与スコア (skip 時 null)。 */
export async function scoreArticle(db: Db, articleId: number): Promise<number | null> {
  const article = getArticle(db, articleId);
  if (!article) return null;

  const interests = listEnabledInterests(db);
  if (interests.length === 0) {
    setArticleScore(db, articleId, { score: null, reason: null, matched: null, status: 'skip' });
    return null;
  }

  try {
    const out = await runLlm({
      task: 'rss_score',
      prompt: buildPrompt(article, interests),
      timeoutMs: 30_000,
    });
    const parsed = extractJson(out);
    if (!parsed) {
      setArticleScore(db, articleId, { score: null, reason: 'AI 応答を解釈できませんでした', matched: null, status: 'error' });
      return null;
    }
    // マッチしたテーマの weight でスコアを補正 (上限 1.0)。
    const matchedInterest = parsed.matched
      ? interests.find(it => it.label === parsed.matched)
      : undefined;
    const weight = matchedInterest?.weight ?? 1.0;
    const finalScore = Math.min(1, parsed.score * weight);
    setArticleScore(db, articleId, {
      score: finalScore,
      reason: parsed.reason || null,
      matched: parsed.matched,
      status: 'done',
    });
    return finalScore;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setArticleScore(db, articleId, { score: null, reason: `採点失敗: ${msg.slice(0, 120)}`, matched: null, status: 'error' });
    return null;
  }
}
