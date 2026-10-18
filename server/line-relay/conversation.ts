// LINE の 1 イベントへの返事。 Concordia が Memoria 宛てと決めたイベントだけが来る。
// - 「つなぐ <6 桁>」: Memoria が出したコードならトークを紐付ける (linked)。 知らないコードは他サービス宛てなので黙る。
// - 紐付いていないトーク: 「つなぐ」 の案内を返す。
// - 「タスク ○○」「にっき ○○」: 確認ボタンを出し、「はい」 で足す。 「きょうのタスク」: 今日の未完了を最大 10 件。
// - それ以外 (Memoria がふだんの相手のときの言葉なし発言): 使い方を返す。
// - leave: 紐付けを消す (unlinked)。 本文・replyToken はログに出さない。

import type BetterSqlite3 from 'better-sqlite3';
import type { LineRelayActions } from './actions.js';
import type { LineRelayEvent } from './events.js';
import { forgetLineTalk, isLineTalkLinked, redeemLineLinkCode } from './links.js';
import { confirmMessage, parseConfirmPostback, textMessage, type LineTextMessage } from './messages.js';
import { createLinePending, takeLinePending, type PendingAction } from './pending.js';

type Db = BetterSqlite3.Database;

export interface ConversationDeps {
  db: Db;
  actions: LineRelayActions;
  now: Date;
}

export interface ConversationReply {
  messages: LineTextMessage[];
  linked?: true;
  unlinked?: true;
}

export const TODAY_TASK_LIMIT = 10;
const TASK_TITLE_MAX = 200;
const DIARY_TEXT_MAX = 1000;

export const USAGE_TEXT = [
  'Memoria でできること:',
  '・タスク ○○ … タスクを 1 件足す',
  '・きょうのタスク … 今日の未完了タスクを見る',
  '・にっき ○○ … 今日の日記に一言足す',
].join('\n');

export const LINK_GUIDE_TEXT = 'このトークはまだ Memoria とつながっていません。'
  + 'Memoria の設定「🏠 帰宅・出発 / LINE」の「LINE 連携 (Concordia 経由)」で 6 桁のコードを出して、'
  + '「つなぐ 123456」のように送ってください。';

const LINK_RE = /^つなぐ[\s　]*([0-9０-９]{6})[\s　]*$/;
const TODAY_RE = /^(?:きょうの|今日の)タスク[\s　]*$/;
const TASK_RE = /^タスク(?:[\s　]+|$)([\s\S]*)$/;
const DIARY_RE = /^(?:にっき|日記)(?:[\s　]+|$)([\s\S]*)$/;

const say = (text: string): ConversationReply => ({ messages: [textMessage(text)] });
const none = (): ConversationReply => ({ messages: [] });

function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function link(deps: ConversationDeps, talk: string, rawCode: string): ConversationReply {
  const result = redeemLineLinkCode(deps.db, talk, toHalfWidthDigits(rawCode), deps.now);
  switch (result) {
    case 'linked':
      return { messages: [textMessage(`Memoria とつながりました。\n${USAGE_TEXT}`)], linked: true };
    case 'expired':
      return say('このコードは有効期限が切れています。Memoria の設定で新しいコードを出してください。');
    case 'used':
      return say('このコードはもう使われています。Memoria の設定で新しいコードを出してください。');
    case 'unknown':
      // 「つなぐ」 は全サービスへ回るので、 Memoria のコードでなければ黙る。
      return none();
  }
}

async function todayTasks(deps: ConversationDeps): Promise<ConversationReply> {
  const tasks = await deps.actions.listTodayTasks(deps.now);
  if (!tasks.length) return say('今日締切・期限切れの未完了タスクはありません。');
  const shown = tasks.slice(0, TODAY_TASK_LIMIT).map((task) => `・${[...oneLine(task.title)].slice(0, 60).join('')}`);
  const more = tasks.length > TODAY_TASK_LIMIT ? [`…ほか ${tasks.length - TODAY_TASK_LIMIT} 件`] : [];
  return say([`今日の未完了タスク (${tasks.length} 件)`, ...shown, ...more].join('\n'));
}

function askConfirm(deps: ConversationDeps, talk: string, action: PendingAction, text: string): ConversationReply {
  const id = createLinePending(deps.db, talk, action, text, deps.now);
  const question = action === 'task' ? `「${text}」をタスクに足しますか？` : `今日の日記に足しますか？\n「${text}」`;
  return { messages: [confirmMessage(question, id)] };
}

async function handleText(deps: ConversationDeps, talk: string, raw: string): Promise<ConversationReply> {
  const text = raw.replace(/^[\s　]+/, '');
  const linkMatch = LINK_RE.exec(text);
  if (linkMatch) return link(deps, talk, linkMatch[1]!);
  if (!isLineTalkLinked(deps.db, talk)) return say(LINK_GUIDE_TEXT);
  if (TODAY_RE.test(text)) return todayTasks(deps);
  const task = TASK_RE.exec(text);
  if (task) {
    const title = oneLine(task[1]!);
    if (!title) return say('「タスク 牛乳を買う」のように、足したいことを続けて送ってください。');
    if ([...title].length > TASK_TITLE_MAX) return say(`タスクは ${TASK_TITLE_MAX} 文字以内で送ってください。`);
    return askConfirm(deps, talk, 'task', title);
  }
  const diary = DIARY_RE.exec(text);
  if (diary) {
    const body = oneLine(diary[1]!);
    if (!body) return say('「にっき 散歩した」のように、足したいことを続けて送ってください。');
    if ([...body].length > DIARY_TEXT_MAX) return say(`日記は ${DIARY_TEXT_MAX} 文字以内で送ってください。`);
    return askConfirm(deps, talk, 'diary', body);
  }
  return say(USAGE_TEXT);
}

async function handlePostback(deps: ConversationDeps, talk: string, data: string): Promise<ConversationReply> {
  if (!isLineTalkLinked(deps.db, talk)) return say(LINK_GUIDE_TEXT);
  const postback = parseConfirmPostback(data);
  if (!postback) return say('このボタンは使えません。');
  const pending = takeLinePending(deps.db, talk, postback.pendingId, deps.now);
  if (!pending) return say('このボタンはもう使えません。もう一度送ってください。');
  if (postback.answer === 'no') return say('やめました。');
  try {
    if (pending.action === 'task') {
      const task = await deps.actions.createTask({ title: pending.text, requestKey: pending.id }, deps.now);
      return say(`「${task.title}」をタスクに足しました。`);
    }
    deps.actions.appendDiary(pending.text, deps.now);
    return say('今日の日記に足しました。');
  } catch (error: unknown) {
    console.warn(`[line-relay] ${pending.action} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    return say('うまく足せませんでした。少し待ってからもう一度送ってください。');
  }
}

export async function replyToLineEvent(deps: ConversationDeps, event: LineRelayEvent): Promise<ConversationReply> {
  switch (event.type) {
    case 'text':
      return handleText(deps, event.talk, event.text);
    case 'postback':
      return handlePostback(deps, event.talk, event.data);
    case 'follow':
    case 'join':
      return say(isLineTalkLinked(deps.db, event.talk) ? `Memoria です。\n${USAGE_TEXT}` : `Memoria です。\n${LINK_GUIDE_TEXT}`);
    case 'leave':
      return forgetLineTalk(deps.db, event.talk) ? { messages: [], unlinked: true } : none();
    case 'memberLeft':
    case 'memberJoined':
      return none();
  }
}
