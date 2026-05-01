// ── domain catalog ---------------------------------------------------------

export function getDomainCatalog(db, domain) {
  return db.prepare(`SELECT * FROM domain_catalog WHERE domain = ?`).get(domain) ?? null;
}

export function listDomainCatalog(db, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT * FROM domain_catalog
    ORDER BY (status = 'done') DESC, fetched_at DESC
    LIMIT ?
  `).all(limit);
}

/** Bulk fetch by domain set; returns { domain → row }. */
export function getDomainCatalogMap(db, domains) {
  if (!domains.length) return new Map();
  const placeholders = domains.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM domain_catalog WHERE domain IN (${placeholders})`).all(...domains);
  return new Map(rows.map(r => [r.domain, r]));
}

export function insertDomainPending(db, domain) {
  db.prepare(`
    INSERT OR IGNORE INTO domain_catalog (domain, status) VALUES (?, 'pending')
  `).run(domain);
}

export function setDomainCatalog(db, domain, patch) {
  // Don't clobber user-edited columns. Caller should pass only the fields
  // it produced; we COALESCE so untouched columns keep their value.
  db.prepare(`
    UPDATE domain_catalog
       SET title = COALESCE(?, title),
           site_name = CASE WHEN user_edited = 1 THEN site_name ELSE COALESCE(?, site_name) END,
           description = CASE WHEN user_edited = 1 THEN description ELSE COALESCE(?, description) END,
           can_do = CASE WHEN user_edited = 1 THEN can_do ELSE COALESCE(?, can_do) END,
           kind = CASE WHEN user_edited = 1 THEN kind ELSE COALESCE(?, kind) END,
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE domain = ?
  `).run(
    patch.title ?? null,
    patch.site_name ?? null,
    patch.description ?? null,
    patch.can_do ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    domain,
  );
}

export function updateDomainCatalogUser(db, domain, patch) {
  // User edit. Mark user_edited=1 so the auto-classifier won't overwrite.
  const fields = [];
  const args = [];
  for (const k of ['site_name', 'description', 'can_do', 'kind', 'notes']) {
    if (typeof patch[k] === 'string' || patch[k] === null) {
      fields.push(`${k} = ?`);
      args.push(patch[k] ?? null);
    }
  }
  if (fields.length === 0) return;
  fields.push(`user_edited = 1`);
  args.push(domain);
  db.prepare(`UPDATE domain_catalog SET ${fields.join(', ')} WHERE domain = ?`).run(...args);
}

export function listDomainCatalogWithCounts(db, { limit = 500, search } = {}) {
  const args = [];
  let where = '';
  if (search) {
    where = `WHERE c.domain LIKE ? OR c.site_name LIKE ? OR c.description LIKE ? OR c.can_do LIKE ?`;
    const pat = `%${search}%`;
    args.push(pat, pat, pat, pat);
  }
  const rows = db.prepare(`
    SELECT c.*,
           COALESCE(d.daily_visits, 0)    AS visits_today,
           COALESCE(w.weekly_visits, 0)   AS visits_week,
           COALESCE(t.total_visits, 0)    AS visits_total
      FROM domain_catalog c
      LEFT JOIN (
        SELECT instr(SUBSTR(url, INSTR(url, '://') + 3), '/') AS slash,
               LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS daily_visits
          FROM page_visits
         WHERE date(last_seen_at, 'localtime') = date('now', 'localtime')
         GROUP BY dom
      ) d ON d.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS weekly_visits
          FROM page_visits
         WHERE last_seen_at >= datetime('now', '-7 days')
         GROUP BY dom
      ) w ON w.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS total_visits
          FROM page_visits
         GROUP BY dom
      ) t ON t.dom = c.domain
     ${where}
     ORDER BY visits_today DESC, visits_week DESC, c.domain ASC
     LIMIT ?
  `).all(...args, Number(limit) || 500);
  return rows;
}

export function deleteDomainCatalog(db, domain) {
  db.prepare(`DELETE FROM domain_catalog WHERE domain = ?`).run(domain);
}
