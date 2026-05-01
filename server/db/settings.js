// ── app settings (key/value) ----------------------------------------------

export function getAppSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Keys whose stored row should be DELETED when the user clears them
// (credentials / one-shot session info — empty string == cleared and we
// don't want stale rows lying around). Everything else preserves an
// empty string as an empty string so plain text fields like
// `diary.global_memo` don't get auto-wiped when the user happens to
// save the panel with the textarea empty for a moment.
const DELETE_ON_EMPTY_KEYS = new Set([
  'multi_jwt', 'multi_user_id', 'multi_user_name', 'multi_role',
  'multi_connected_at', 'multi_url',
  'llm.openai.api_key',
  'github_token',
]);

export function setAppSettings(db, patch) {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || (v === '' && DELETE_ON_EMPTY_KEYS.has(k))) {
        db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(k);
      } else {
        db.prepare(`
          INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(k, String(v));
      }
    }
  });
  tx();
}
