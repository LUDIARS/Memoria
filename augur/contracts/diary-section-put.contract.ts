// Contract for putDiarySection (C-12): one section per (date, source), stored as given.

interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }
interface Section { date: string; source: string; title: string; markdown: string }

export default {
  post: (result: Section, db: Db, date: string, source: string, input: { title: string; markdown: string }): true | string => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM diary_sections WHERE date = ? AND source = ?').get(date, source) as { n: number };
    if (row.n !== 1) return 'exactly one section must exist for (date, source)';
    return (result.date === date && result.source === source && result.title === input.title && result.markdown === input.markdown)
      || 'stored section must equal the input';
  },
};
