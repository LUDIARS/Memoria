// Contract for deleteDiarySections (C-13): deleting a diary day leaves no external section behind.

interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }

export default {
  post: (_result: number, db: Db, date: string): true | string => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM diary_sections WHERE date = ?').get(date) as { n: number };
    return row.n === 0 || 'external sections must be removed with the diary day';
  },
};
