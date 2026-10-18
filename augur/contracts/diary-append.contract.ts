// Contract for appendDiaryLine (C-17): appending keeps the previous diary notes and ends with the new line.
// appendDiaryLine is synchronous, so pre can keep the previous notes for post in module state.

interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }

let before: string | null = null;

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function notesOf(db: Db, now: Date): string {
  const row = db.prepare('SELECT notes FROM diary_entries WHERE date = ?').get(localDate(now)) as { notes: string | null } | undefined;
  return String(row?.notes ?? '');
}

export default {
  pre: (db: Db, _line: string, now: Date = new Date()): true => {
    before = notesOf(db, now).trimEnd();
    return true;
  },
  post: (_result: void, db: Db, line: string, now: Date = new Date()): true | string => {
    const previous = before ?? '';
    before = null;
    const after = notesOf(db, now);
    if (!after.startsWith(previous)) return 'existing diary notes must be kept';
    return after.trimEnd().endsWith(line.trim()) || 'the new line must be appended at the end';
  },
};
