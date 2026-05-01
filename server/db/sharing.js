// ── share metadata --------------------------------------------------------
//
// Mark a local row as having been forwarded to a multi server. owner_user_id
// stays NULL on the local side (NULL = "this is mine") — the multi-side row
// is the one that carries the Cernere user id. shared_origin records the
// remote we forwarded to so re-shares can be detected later.
//
// Downloaded rows go the other way: they came from a multi server, so we set
// owner_user_id / owner_user_name to the remote owner so the UI can render
// "by <user>" without confusing them with rows the user authored locally.
export function setBookmarkOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE bookmarks SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDigOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dig_sessions SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDictionaryOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dictionary_entries SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function markBookmarkShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE bookmarks SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDigShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dig_sessions SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDictionaryShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dictionary_entries SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}
