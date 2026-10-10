// Contract for validateDiarySectionInput (spec/tasks/2026-10-10-diary-external-sections.md, C-11).
// An accepted input always satisfies the documented bounds; a rejection carries a reason.

const MAX_MARKDOWN_BYTES = 200 * 1024;

type Result = { ok: true; title: string; markdown: string } | { ok: false; error: string };

export default {
  post: (result: Result, date: string, source: string): true | string => {
    if (!result.ok) return (typeof result.error === 'string' && result.error.length > 0) || 'rejection must carry a reason';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'accepted an invalid date';
    if (!/^[a-z0-9-]{1,64}$/.test(source)) return 'accepted an invalid source';
    if (!result.title.trim() || result.title.length > 200) return 'accepted a title outside 1..200 chars';
    if (!result.markdown.trim() || Buffer.byteLength(result.markdown, 'utf8') > MAX_MARKDOWN_BYTES) return 'accepted markdown outside 1..200KB';
    return true;
  },
};
