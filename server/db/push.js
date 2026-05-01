// ── push_subscriptions DAO ────────────────────────────────────

export function findPushSubscriptionByEndpoint(db, endpoint) {
  return db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`).get(endpoint);
}

export function listActivePushSubscriptions(db) {
  return db.prepare(`
    SELECT id, endpoint, p256dh, auth, label, user_agent, created_at
    FROM push_subscriptions
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `).all();
}

export function listPushSubscriptions(db) {
  return db.prepare(`
    SELECT id, endpoint, label, user_agent, created_at, revoked_at
    FROM push_subscriptions
    ORDER BY (revoked_at IS NOT NULL), created_at DESC
  `).all();
}

/**
 * Insert / update a subscription. If `id` is supplied the row is upserted
 * (used to re-enable a revoked endpoint without losing its label).
 * Returns the row id.
 */
export function insertPushSubscription(db, { id, endpoint, p256dh, auth, label, userAgent, revokedAt }) {
  if (id) {
    db.prepare(`
      UPDATE push_subscriptions
      SET endpoint = ?, p256dh = ?, auth = ?, label = ?, user_agent = ?, revoked_at = ?
      WHERE id = ?
    `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null, revokedAt ?? null, id);
    return id;
  }
  const info = db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null);
  return info.lastInsertRowid;
}

export function markPushSubscriptionRevoked(db, id) {
  db.prepare(`UPDATE push_subscriptions SET revoked_at = datetime('now') WHERE id = ?`).run(id);
}

export function deletePushSubscription(db, id) {
  const info = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
  return info.changes;
}
