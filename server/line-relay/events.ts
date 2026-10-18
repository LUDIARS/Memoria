// Concordia が中継する LINE の webhook 本文 (`{"destination","events":[...]}`) から、 扱うイベントだけを取り出す。
// 振り分けは Concordia が済ませているので、 ここに来たイベントはすべて Memoria 宛て。
// トークは user:<userId> / group:<groupId> / room:<roomId> で表す。
// テキストの中のボットへのメンション (mention.mentionees の isSelf) は文から外す。
// ほかのイベント (スタンプ・画像・unfollow など) は読み捨てる。

export type LineRelayEvent =
  | { readonly type: 'text'; readonly talk: string; readonly replyToken: string; readonly text: string }
  | { readonly type: 'postback'; readonly talk: string; readonly replyToken: string; readonly data: string }
  | { readonly type: 'follow' | 'join'; readonly talk: string; readonly replyToken: string }
  | { readonly type: 'leave' | 'memberLeft' | 'memberJoined'; readonly talk: string; readonly replyToken?: undefined };

export class LineRelayBodyError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function talkOf(source: unknown): string | undefined {
  if (!isObject(source)) return undefined;
  const id = source.type === 'user' ? str(source.userId)
    : source.type === 'group' ? str(source.groupId)
      : source.type === 'room' ? str(source.roomId)
        : undefined;
  return id === undefined ? undefined : `${source.type as string}:${id}`;
}

/** ボットへのメンション (isSelf) の文字を外した文。 index / length は UTF-16 の位置。 */
function stripSelfMentions(text: string, mention: unknown): string {
  const mentionees = isObject(mention) && Array.isArray(mention.mentionees) ? mention.mentionees : [];
  const self = mentionees
    .filter((item): item is Json => isObject(item) && item.isSelf === true && Number.isInteger(item.index) && Number.isInteger(item.length))
    .map((item) => ({ index: item.index as number, length: item.length as number }))
    .filter((item) => item.index >= 0 && item.length > 0 && item.index + item.length <= text.length)
    .sort((a, b) => b.index - a.index);
  let rest = text;
  for (const item of self) rest = rest.slice(0, item.index) + rest.slice(item.index + item.length);
  return rest.trim();
}

function toEvent(raw: unknown): LineRelayEvent | undefined {
  if (!isObject(raw)) return undefined;
  const talk = talkOf(raw.source);
  if (talk === undefined) return undefined;
  const replyToken = str(raw.replyToken);
  switch (raw.type) {
    case 'message': {
      const message = raw.message;
      if (!isObject(message) || message.type !== 'text' || replyToken === undefined) return undefined;
      const text = str(message.text);
      return text === undefined ? undefined : { type: 'text', talk, replyToken, text: stripSelfMentions(text, message.mention) };
    }
    case 'postback': {
      const data = isObject(raw.postback) ? str(raw.postback.data) : undefined;
      return data === undefined || replyToken === undefined ? undefined : { type: 'postback', talk, replyToken, data };
    }
    case 'follow':
    case 'join':
      return replyToken === undefined ? undefined : { type: raw.type, talk, replyToken };
    case 'leave':
    case 'memberLeft':
    case 'memberJoined':
      return { type: raw.type, talk };
    default:
      return undefined;
  }
}

export function parseLineRelayEvents(body: unknown): LineRelayEvent[] {
  if (!isObject(body) || !Array.isArray(body.events)) throw new LineRelayBodyError('body has no events');
  return body.events.map(toEvent).filter((event): event is LineRelayEvent => event !== undefined);
}
