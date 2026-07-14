// 記事の AI 要約。 記事ページ本文を取得して 2-3 文に圧縮する。
// 本文取得に失敗したらフィード提供の summary + タイトルから要約する。

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import { fetchPageHtml } from '../lib/fetch-page.js';
import { getArticle, setArticleSummary } from './store.js';

type Db = BetterSqlite3.Database;

function htmlToText(html: string): string {
  // <body> 以降に絞ってタグ除去 (nav/script/style を落とす)。
  const body = html.replace(/[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  return body
    .replace(/<(script|style|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 1 記事を AI 要約して DB に保存。 戻り値は要約文 (失敗時 null)。 */
export async function summarizeArticle(db: Db, articleId: number): Promise<string | null> {
  const article = getArticle(db, articleId);
  if (!article) return null;

  // 本文取得 (失敗してもフィード summary で続行)。
  let bodyText = '';
  if (article.url && /^https?:\/\//.test(article.url)) {
    try {
      const { html } = await fetchPageHtml(article.url, 15_000);
      bodyText = htmlToText(html).slice(0, 6000);
    } catch { /* フォールバックへ */ }
  }
  const material = bodyText.length > 200
    ? bodyText
    : [article.title, article.summary].filter(Boolean).join('\n');

  const prompt = [
    '次の記事を日本語で 2〜3 文に要約してください。',
    '事実ベースで簡潔に。 前置き (「この記事は」 等) や感想は不要。 要約本文のみを出力。',
    '',
    `タイトル: ${article.title}`,
    '本文:',
    material.slice(0, 6000),
  ].join('\n');

  try {
    const out = await runLlm({ task: 'rss_summarize', prompt, timeoutMs: 40_000 });
    const summary = out.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim().slice(0, 600);
    if (!summary) return null;
    setArticleSummary(db, articleId, summary);
    return summary;
  } catch (e: unknown) {
    console.error('[rss] summarize failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
