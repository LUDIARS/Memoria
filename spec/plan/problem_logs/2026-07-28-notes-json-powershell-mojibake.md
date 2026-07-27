# Notes JSON appears mojibake in Windows PowerShell 5.1

- Date: 2026-07-28
- Status: unresolved
- Area: Notes API / HTTP response encoding
- Severity: medium — stored data is intact, but PowerShell API consumers can misread Japanese text

## Summary

This is a text-corruption regression at the HTTP client boundary. A Japanese note created through
`memoria-task/post-notes.mjs` is stored correctly, but `Invoke-RestMethod` in Windows PowerShell 5.1
returns mojibake for the note title and block text.

## Evidence

- At 2026-07-28 02:37–02:39 JST, note `5e3794b5-627d-480c-8951-29aeadb57d7a` was created with
  title `流出監査・履歴修正記録 2026-07-27` and 70 blocks.
- `Invoke-RestMethod GET /api/notes/:id` rendered the title and first block as UTF-8 bytes decoded
  through a legacy single-byte code page.
- Node `fetch` against the same endpoint returned the correct Japanese title and first block
  `概要`.
- The response header observed by Node was `Content-Type: application/json` without an explicit
  charset.
- The stored note is valid; this is not database corruption.

## Regression Context

The shared `memoria-task` skill uses Node specifically to avoid Windows PowerShell mojibake.
Manual verification through PowerShell still produced a false corruption signal because the API
response did not declare UTF-8 explicitly.

## Cause

Leading hypothesis: Windows PowerShell 5.1 applies a legacy response decoding when JSON lacks an
explicit `charset=utf-8`. Hono serializes UTF-8 correctly, but the current response header does not
make that contract unambiguous to this client.

## Fix Requirements

- Serve JSON responses as `application/json; charset=utf-8` at a common response boundary.
- Preserve the existing UTF-8 response bytes and stored values.
- Do not add endpoint-specific charset patches when a shared Hono middleware/header policy can
  cover all JSON APIs.
- Keep Node and browser clients compatible.

## Verification

- Add a response-header regression test for a Notes API JSON response.
- Round-trip a Japanese title and block through create, list, and detail endpoints.
- Verify both Node `fetch` and Windows PowerShell 5.1 decode the same Japanese values.
- Confirm an existing note is unchanged after the header fix.

## Follow-up

- Review other JSON endpoints for the same missing charset.
- Update the Memoria note-posting verification guidance to prefer Node until the server header fix
  is deployed.
