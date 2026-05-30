// メッセージを 6 アクションのいずれかに振り分ける (Imperativus 風だが実行は
// 制限アクションのみ)。 判定順:
//   1. チャンネル名 (#task/#memo/#bookmark/#meal) → 決定的ルーティング
//   2. 添付画像 → meal / 本文に URL → bookmark
//   3. それ以外 + ai_process ON → AI で意図分類 → task/memo/bookmark/recommend
// 任意 shell/コード実行はしない。 失敗時は何もせず capture のログだけ残る。

import { type Client, type Message, Events } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import { discordSettings, type DiscordSettings } from './settings.js';
import { isSelf } from './user-map.js';
import { createTask, createMemo } from './actions/task.js';
import { createBookmark, extractFirstUrl } from './actions/bookmark.js';
import { createMeal } from './actions/meal.js';
import { runRecommend } from './actions/recommend.js';

type Db = BetterSqlite3.Database;
type Action = 'task' | 'memo' | 'bookmark' | 'meal' | 'recommend' | 'none';

function channelName(msg: Message): string {
  return 'name' in msg.channel && msg.channel.name ? msg.channel.name : '';
}

interface Interpreted {
  action: Action;
  title?: string;
  dueAt?: string | null;
  /** カンマ区切りカテゴリ ("買い物, 開発")。 */
  category?: string | null;
  details?: string | null;
}

/**
 * AI に意図分類 + タスク内容の解釈をさせる。 task のときは title/category/due/details を
 * 構造化して「カード」 として成形する。 失敗時 none。
 */
async function classify(text: string): Promise<Interpreted> {
  const prompt = `あなたはライフログ Bot のルーターです。次のメッセージを task/memo/bookmark/recommend のいずれかに分類し、JSON のみで答えてください。\n` +
    `task=締切のある予定/やること, memo=締切のないメモ, recommend=おすすめ要求, bookmark=保存したいURL。\n` +
    `task の場合は内容を解釈して title(簡潔な見出し) / category(買い物・開発 等のカンマ区切り、無ければ空) / due_at(ISO8601 か null) / details(補足、無ければ空) を埋めること。\n` +
    `形式: {"action":"task|memo|bookmark|recommend|none","title":"...","due_at":"ISO8601 or null","category":"...","details":"..."}\n\nメッセージ: ${text}`;
  try {
    const raw = await runLlm({ task: 'discord_route', prompt, timeoutMs: 30_000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { action: 'none' };
    const j = JSON.parse(m[0]) as {
      action?: string; title?: string; due_at?: string | null; category?: string | null; details?: string | null;
    };
    const allowed: string[] = ['task', 'memo', 'bookmark', 'recommend'];
    const action: Action = allowed.includes(j.action ?? '') ? (j.action as Action) : 'none';
    return { action, title: j.title, dueAt: j.due_at ?? null, category: j.category ?? null, details: j.details ?? null };
  } catch {
    return { action: 'none' };
  }
}

/** classify 結果を createTask 入力に。 title が空なら原文で補う。 */
function toTaskInput(text: string, r: Interpreted) {
  return { title: r.title || text, dueAt: r.dueAt, category: r.category, details: r.details };
}

async function dispatch(db: Db, cfg: DiscordSettings, msg: Message): Promise<string | null> {
  const text = (msg.content ?? '').trim();
  const ch = channelName(msg);
  const image = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  const url = extractFirstUrl(text);

  // 1. チャンネル決定的ルーティング
  // #task は AI でカード成形してから登録 (ai_process OFF なら原文をそのまま title)。
  if (ch === 'task' && cfg.autoTask) {
    if (!cfg.aiProcess || !text) return createTask({ title: text });
    return createTask(toTaskInput(text, await classify(text)));
  }
  if (ch === 'memo' && cfg.autoMemo) return createMemo(text);
  if (ch === 'bookmark' && cfg.autoBookmark && url) return createBookmark(url);
  if (ch === 'meal' && cfg.autoMeal && image) return createMeal({ url: image.url, name: image.name, contentType: image.contentType }, text);

  // 2. 構造判定 (どの channel でも)
  if (image && cfg.autoMeal) return createMeal({ url: image.url, name: image.name, contentType: image.contentType }, text);
  if (url && cfg.autoBookmark) return createBookmark(url);

  // 3. AI 分類
  if (!cfg.aiProcess || !text) return null;
  const r = await classify(text);
  if (r.action === 'task' && cfg.autoTask) return createTask(toTaskInput(text, r));
  if (r.action === 'memo' && cfg.autoMemo) return createMemo(r.title || text);
  if (r.action === 'bookmark' && cfg.autoBookmark && url) return createBookmark(url);
  if (r.action === 'recommend' && cfg.autoRecommend) return runRecommend(db);
  return null;
}

/** ルーターを Client に登録する。 self の投稿のみ処理。 */
export function registerRouter(client: Client, db: Db): void {
  client.on(Events.MessageCreate, (msg) => {
    const cfg = discordSettings(db);
    if (msg.author?.bot || !isSelf(cfg, msg.author?.id)) return;
    void (async () => {
      try {
        const summary = await dispatch(db, cfg, msg);
        if (summary) {
          await msg.react('✅').catch(() => {});
          await msg.reply(summary).catch(() => {});
        }
      } catch {
        // best-effort — 失敗しても capture ログは残る
      }
    })();
  });
}
