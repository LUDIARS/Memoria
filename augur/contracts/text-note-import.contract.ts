// Contract for importTextNote (C-14): one mapping per external_id, and the returned note is the mapped one.
// A failed Tabula import throws before the mapping is written, so no post observation exists for it.

interface Db { prepare(sql: string): { all(...params: unknown[]): unknown[] } }
interface Result { note: { id: string }; url: string; external_id: string }

export default {
  post: (result: Result, db: Db, input: { external_id: string }): true | string => {
    const rows = db.prepare('SELECT note_id, note_url FROM external_notes WHERE external_id = ?').all(input.external_id) as { note_id: string; note_url: string }[];
    if (rows.length !== 1) return 'exactly one mapping must exist per external_id';
    return (rows[0].note_id === result.note.id && rows[0].note_url === result.url) || 'returned note must be the mapped note';
  },
};
