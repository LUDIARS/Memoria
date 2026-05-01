// ── page metadata (per-URL) -----------------------------------------------

export function getPageMetadata(db, url) {
  return db.prepare(`SELECT * FROM page_metadata WHERE url = ?`).get(url) ?? null;
}

export function getPageMetadataMap(db, urls) {
  if (!urls.length) return new Map();
  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM page_metadata WHERE url IN (${placeholders})`).all(...urls);
  return new Map(rows.map(r => [r.url, r]));
}

export function insertPageMetadataPending(db, url) {
  db.prepare(`
    INSERT OR IGNORE INTO page_metadata (url, status) VALUES (?, 'pending')
  `).run(url);
}

export function setPageMetadata(db, url, patch) {
  db.prepare(`
    UPDATE page_metadata
       SET title = COALESCE(?, title),
           meta_description = COALESCE(?, meta_description),
           og_title = COALESCE(?, og_title),
           og_description = COALESCE(?, og_description),
           og_image = COALESCE(?, og_image),
           og_type = COALESCE(?, og_type),
           content_type = COALESCE(?, content_type),
           http_status = COALESCE(?, http_status),
           summary = COALESCE(?, summary),
           kind = COALESCE(?, kind),
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE url = ?
  `).run(
    patch.title ?? null,
    patch.meta_description ?? null,
    patch.og_title ?? null,
    patch.og_description ?? null,
    patch.og_image ?? null,
    patch.og_type ?? null,
    patch.content_type ?? null,
    patch.http_status ?? null,
    patch.summary ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    url,
  );
}

export function deletePageMetadata(db, url) {
  db.prepare(`DELETE FROM page_metadata WHERE url = ?`).run(url);
}
