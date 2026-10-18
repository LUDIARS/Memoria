// Contract for redeemLineLinkCode (C-16): only a live, unused code links the talk, and it is spent afterwards.

interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }

export default {
  post: (result: string, db: Db, talk: string, code: string): true | string => {
    if (result !== 'linked') return true;
    const link = db.prepare('SELECT talk FROM line_relay_links WHERE talk = ?').get(talk);
    if (!link) return 'a linked result must leave a link row for the talk';
    const row = db.prepare('SELECT used_at FROM line_relay_link_codes WHERE code = ?').get(code) as { used_at: string | null } | undefined;
    return (row !== undefined && row.used_at !== null) || 'a redeemed code must be marked used';
  },
};
