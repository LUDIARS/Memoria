# Actio task source

Actio owns task and goal content, status, deadline, creator and categories. Memoria's
existing task API, reminders, briefing, review, triage, Alexa and agent dispatch use
the asynchronous task store. Actio's existing Memoria-compatible input fields and
core task schema are reused.

`ACTIO_URL` is provided by the Actio-owned Excubitor catalog. An optional
`ACTIO_API_TOKEN` supplies service authentication. Missing configuration, transport
errors and malformed upstream responses fail visibly. There is no automatic local
DB fallback. `MEMORIA_TASK_BACKEND=sqlite` is an explicit legacy/test selection.

`actio_task_ids` only maps local numeric IDs to Actio IDs. Imported `memoria:<id>`
references preserve existing diary/review/agent/Discord links. All old task IDs are
reserved before allocating IDs for native Actio tasks. The old `tasks` table is
retained as a migration archive and is not updated in Actio mode. The old share
endpoint returns the existing task without creating another copy.

Run `server/scripts/migrate-tasks-to-actio.mjs` with catalog-resolved `MEMORIA_URL`,
`ACTIO_URL` and `--snapshot <new local path>`. The default is read-only preflight;
`--apply` imports every status and both kinds. Actio's unique `source/sourceRef`
contract makes retries idempotent. `pluginPayload.memoria` preserves the complete
original row, including original timestamps. Existing conflicting imports stop the
migration. A final complete readback and source stability check precede cutover.
Run migration before cutover, while Memoria still serves its original SQLite data.
The script rejects an Actio-backed source using the task API backend header.
Never commit snapshots containing personal task data.

Task mutation completes at Actio before Memoria records journal or triage metadata.
SQLite transactions do not span HTTP calls. If a local journal write fails after an
upstream success, the error is visible; reconcile against Actio rather than creating
another task. Alexa uses its stable request ID as the upstream idempotency key.

Validation scenarios: imported IDs and native IDs do not collide; changed remote
content is visible; pagination is preserved; upstream failure does not write the
archive; completed tasks, goals, dates and category registrations survive migration.

Goal evaluation titles and newly generated Clever Search reports also read Actio.
Saved search reports remain historical snapshots; the refresh action rebuilds them
from current task content and excludes the old task index from results.
