// おすすめダイジェスト — 直近の上位記事を AI が束ねた日次ブリーフィング。
// = 「ツールを開いたら自分好みの記事がまとまっている」 を 1 画面で叶える。

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import {
  listRecentTopArticles, listEnabledInterests, getDigest, upsertDigest,
} from './store.js';
import type { RssDigestRow } from './types.js';

type Db = BetterSqlite3.Database;

/** ローカル日付 (YYYY-MM-DD)。 */
function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 直近の上位記事から日次ダイジェストを生成し DB に保存。 記事が無ければ null。 */
export async function generateDigest(db: Db): Promise<RssDigestRow | null> {
  const articles = listRecentTopArticles(db, 36, 15);
  if (articles.length === 0) return null;

  const interests = listEnabledInterests(db);
  const interestLine = interests.length
    ? `読者の興味: ${interests.map(i => i.label).join(' / ')}`
    : '読者の興味設定: なし (一般的な注目度で選定)';

  const list = articles.map((a, i) => {
    const score = a.ai_score != null ? ` [一致度 ${Math.round(a.ai_score * 100)}]` : '';
    const src = a.feed_title ? ` (${a.feed_title})` : '';
    const sum = a.ai_summary || a.summary || '';
    return `${i + 1}. ${a.title}${src}${score}\n   ${sum}`.trim();
  }).join('\n');

  const prompt = [
    'あなたは読者専用のニュースキュレーターです。',
    '以下は直近で集まった記事です。 これを元に、 日本語の「今日のダイジェスト」を Markdown で作成してください。',
    '',
    interestLine,
    '',
    '# 構成',
    '## 今日の注目ポイント',
    '(全体を 2〜3 文で俯瞰。 読者の興味に響くトピックを優先)',
    '## ピックアップ',
    '(特に読むべき記事を 3〜5 件、 各 1 行で「- **見出し** — なぜ注目か」 形式)',
    '## その他のトピック',
    '(残りを 1 行ずつ簡潔に)',
    '',
    '事実ベースで簡潔に。 記事に無い情報は足さない。 Markdown のみを出力。',
    '',
    '# 記事一覧',
    list,
  ].join('\n');

  const out = await runLlm({ task: 'rss_digest', prompt, timeoutMs: 90_000 });
  const content = out.trim().replace(/^```(?:markdown)?\s*\n|```$/g, '').trim();
  if (!content) return null;

  const date = localDate();
  upsertDigest(db, date, content, articles.map(a => a.id));
  return getDigest(db, date) ?? null;
}

/** 当日のダイジェストがあれば返す。 無ければ生成。 force で再生成。 */
export async function getOrCreateDigest(db: Db, force = false): Promise<RssDigestRow | null> {
  if (!force) {
    const existing = getDigest(db, localDate());
    if (existing) return existing;
  }
  return generateDigest(db);
}
