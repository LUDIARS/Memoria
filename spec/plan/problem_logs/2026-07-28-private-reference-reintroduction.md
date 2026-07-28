# Private Reference Reintroduction

- Date: 2026-07-28
- Status: fixed in working tree
- Area: Corpus hub manifest documentation
- Severity: security hygiene regression

## Summary

A previously removed private-project identifier was reintroduced in a source-code section comment on the remote default branch. This is a regression because the repository had already completed a private-reference cleanup.

## Evidence

- Remote source commit: `23b5c222be82a9504ed30b754eb61a3ebc129883`
- Affected file: `server/index.ts`
- A scan using the external private-reference term set found one match in the current tree.
- The match was documentation-only and did not affect runtime behavior.

## Regression Context

The 2026-07-27 history cleanup recorded zero remaining private-project references. A later default-branch update restored an academy-derived design-document name in a section comment.

## Cause

The section comment retained an old design-document reference instead of using the public Corpus component name.

## Fix Requirements

- Replace the old document name with a public, component-scoped name.
- Keep the current source tree free of every term in the external audit set.
- Publish the sanitized tree as a fresh root commit without the old repository history.
- Update the MemoriaPlugin submodule gitlink to the new history-free repository commit.

## Verification

- Re-run the private-reference and personal-data scans against the staged snapshot.
- Confirm the MemoriaPlugin gitlink resolves in the new public repository.
- Confirm the new Memoria repository contains exactly one commit on `main`.

## Follow-up

Keep the old repository private and archived after transfer. Do not push an old local branch to the recreated repository; reapply required work onto the new `main`.
