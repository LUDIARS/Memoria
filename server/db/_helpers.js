// Shared helpers used across multiple db domain modules.
//
// These were previously private functions inside the monolithic `server/db.js`.
// They are exported so the split-out domain files can import them; the original
// `db.js` re-exports them so external callers keep working.

export function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function extractDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function firstPathSegment(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs[0] || null;
  } catch { return null; }
}
