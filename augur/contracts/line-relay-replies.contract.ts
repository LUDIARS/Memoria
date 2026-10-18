// Contract for handleLineRelayBody (C-18): replies only use reply tokens from the received events, at most 5 messages each.

interface Reply { replyToken: string; messages: unknown[] }
interface Event { replyToken?: string }

export default {
  post: (result: { replies: Reply[] }, _deps: unknown, events: Event[]): true | string => {
    const tokens = new Set(events.map((event) => event.replyToken).filter((token): token is string => typeof token === 'string'));
    const seen = new Set<string>();
    for (const reply of result.replies) {
      if (!tokens.has(reply.replyToken)) return 'a reply must use a reply token from the received events';
      if (seen.has(reply.replyToken)) return 'a reply token must be used once';
      seen.add(reply.replyToken);
      if (reply.messages.length === 0 || reply.messages.length > 5) return 'a reply must carry 1 to 5 messages';
    }
    return true;
  },
};
