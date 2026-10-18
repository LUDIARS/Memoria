// 会話の返事を LINE の返信メッセージにする。 確認は quick reply の 2 つのボタン (「はい」「やめる」) で、
// 押すと postback (`mm:yes:<確認待ち ID>` / `mm:no:<ID>`) が届く。 Concordia は送るときに
// `cc:<サービス名>:` で包み、 押されたら外して Memoria へ回す。

export interface LineTextMessage {
  readonly type: 'text';
  readonly text: string;
  readonly quickReply?: {
    readonly items: readonly {
      readonly type: 'action';
      readonly action: { readonly type: 'postback'; readonly label: string; readonly data: string; readonly displayText: string };
    }[];
  };
}

export type ConfirmAnswer = 'yes' | 'no';

/** LINE のテキストメッセージの上限 (5000 字) より十分短く切る。 */
const MAX_TEXT = 2000;

const clip = (text: string): string => ([...text].length > MAX_TEXT ? `${[...text].slice(0, MAX_TEXT - 1).join('')}…` : text);

const button = (label: string, data: string) => ({ type: 'action' as const, action: { type: 'postback' as const, label, data, displayText: label } });

export function textMessage(text: string): LineTextMessage {
  return { type: 'text', text: clip(text) };
}

export function confirmMessage(question: string, pendingId: string): LineTextMessage {
  return {
    type: 'text',
    text: clip(question),
    quickReply: { items: [button('はい', `mm:yes:${pendingId}`), button('やめる', `mm:no:${pendingId}`)] },
  };
}

/** postback の data。 知らない形なら null。 */
export function parseConfirmPostback(data: string): { readonly answer: ConfirmAnswer; readonly pendingId: string } | null {
  const match = /^mm:(yes|no):([A-Za-z0-9_-]{16,64})$/.exec(data);
  return match === null ? null : { answer: match[1] as ConfirmAnswer, pendingId: match[2] as string };
}
