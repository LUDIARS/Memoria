// ai-hub — 記事ダイジェスト。 前日データから記事候補トピックを抽出し、 上位 N 本を
// 本記事化して保存、 残りを「記事ネタ」 として保存する。
// Spec: spec/feature/ai-hub.md §digest.ts

import type BetterSqlite3 from 'better-sqlite3';
import {
  getAppSettings,
  insertAiArticle, getAiArticle,
  insertAiSeed, getAiSeed,
} from '../db.js';
import { runLlm } from '../llm.js';
import { buildDayContext } from './collect.js';
import { writeArticle } from './generator.js';
import type { TopicCandidate, SourceRef, DigestResult, AiArticle, AiSeed } from './types.js';

type Db = BetterSqlite3.Database;

const DEFAULT_MAX_ARTICLES = 3;

function maxArticles(db: Db): number {
  const raw = getAppSettings(db)['ai_digest.max_articles'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.floor(n)) : DEFAULT_MAX_ARTICLES;
}

/** LLM の出力から JSON 配列を抜き出す (```json フェンス対応)。 */
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

function coerceSourceRefs(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  const out: SourceRef[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : '';
    const ref = typeof o.ref === 'string' ? o.ref : '';
    if (!kind && !ref) continue;
    out.push({ kind, ref, repo: typeof o.repo === 'string' ? o.repo : null });
  }
  return out;
}

function coerceTopic(v: unknown): TopicCandidate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  return {
    title,
    summary: typeof o.summary === 'string' ? o.summary : '',
    angle: typeof o.angle === 'string' ? o.angle : '',
    topicKey: typeof o.topicKey === 'string' ? o.topicKey : '',
    sourceRefs: coerceSourceRefs(o.sourceRefs),
  };
}

/** 前日コンテキストから記事候補トピックを LLM で抽出する (ランク順)。 */
async function extractTopics(context: string): Promise<TopicCandidate[]> {
  const prompt = [
    'あなたはゲーム開発者の作業ログから「技術記事のネタ」 を見つける編集者だ。',
    '以下の作業ログを読み、 技術記事になりうるトピックを重要度の高い順に最大 8 件抽出せよ。',
    '記事性 (他者にとっての学び・面白さ) が高いものを上位にする。 些末な雑務は除外する。',
    '',
    '## 作業ログ',
    context,
    '',
    '## 出力形式',
    '次の JSON 配列だけを返せ (前後に説明を付けない)。 重要度の高い順:',
    '[{ "title": "...", "summary": "なぜ記事になるか", "angle": "提案アングル", "topicKey": "repo:theme 等の重複排除キー", "sourceRefs": [{ "kind": "git_commit", "ref": "...", "repo": "..." }] }]',
  ].join('\n');

  const raw = await runLlm({ task: 'article_topics', prompt });
  return extractJsonArray(raw)
    .map(coerceTopic)
    .filter((t): t is TopicCandidate => t !== null);
}

/**
 * 記事ダイジェストを実行する。
 * - 上位 max_articles 本を writeArticle で本記事化 → insertAiArticle (origin='digest')
 * - 残りを insertAiSeed (status='pending')
 */
export async function runDigest(db: Db, dateStr: string): Promise<DigestResult> {
  const ctx = buildDayContext(db, dateStr);
  const topics = await extractTopics(ctx.text);

  const limit = maxArticles(db);
  const toWrite = topics.slice(0, limit);
  const toSeed = topics.slice(limit);

  const articles: AiArticle[] = [];
  for (const topic of toWrite) {
    try {
      const written = await writeArticle(db, topic);
      const id = insertAiArticle(db, {
        title: written.title,
        body_md: written.body_md,
        topic_key: topic.topicKey || null,
        source_refs: topic.sourceRefs,
        origin: 'digest',
        for_date: dateStr,
        tags: written.tags,
      });
      const row = getAiArticle(db, id);
      if (row) articles.push(row);
    } catch (e: unknown) {
      // 1 本の失敗で全体を止めない。 本記事化に失敗した分は記事ネタとして残す。
      console.warn('[ai-hub digest] writeArticle failed:', e instanceof Error ? e.message : String(e));
      toSeed.push(topic);
    }
  }

  const seeds: AiSeed[] = [];
  for (const topic of toSeed) {
    const sid = insertAiSeed(db, {
      title: topic.title,
      summary: topic.summary,
      angle: topic.angle,
      source_refs: topic.sourceRefs,
      for_date: dateStr,
      status: 'pending',
    });
    const srow = getAiSeed(db, sid);
    if (srow) seeds.push(srow);
  }

  console.log(`[ai-hub digest] ${dateStr}: topics=${topics.length} articles=${articles.length} seeds=${seeds.length}`);
  return { articles, seeds };
}

/**
 * 既存の seed を本記事化する (オンデマンド)。 seed.status を 'done' にし、
 * article_id を紐付ける。 戻り値は作成された記事 (失敗時 null)。
 */
export async function requestSeed(db: Db, seedId: number): Promise<AiArticle | null> {
  const seed = getAiSeed(db, seedId);
  if (!seed) return null;
  const topic: TopicCandidate = {
    title: seed.title,
    summary: seed.summary ?? '',
    angle: seed.angle ?? '',
    topicKey: '',
    sourceRefs: seed.source_refs,
  };
  const written = await writeArticle(db, topic);
  const id = insertAiArticle(db, {
    title: written.title,
    body_md: written.body_md,
    topic_key: null,
    source_refs: seed.source_refs,
    origin: 'requested',
    for_date: seed.for_date,
    tags: written.tags,
  });
  return getAiArticle(db, id);
}
