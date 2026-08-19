# Memoria startup fails through Excubitor job-breakaway

- Date: 2026-08-12
- Status: fixed (excubitor.catalog.yaml の command を node 直起動へ変更)
- Area: Excubitor service catalog / Windows service lifecycle
- Severity: high

## Summary

Memoria could not start through Excubitor. The control endpoint returned HTTP 502
and the declared health endpoint never began listening.

## Evidence

- Excubitor local-control reported `service memoria-server could not be verified
  after breakaway spawn` for each start attempt.
- The catalog used `npm start`, which resolves to `npm.cmd` on Windows.
- Excubitor's job-breakaway launcher cannot retain the shell-mediated `npm.cmd`
  child reliably.

## Cause

The service catalog selected a batch-file entry point for a Windows breakaway
spawn, so the service process was lost before Excubitor could verify its identity.

## Fix Requirements

- Keep the start lifecycle under Excubitor.
- Invoke the existing local `tsx` CLI via `node` directly, without `npm.cmd`.
- Do not alter Memoria user data.

## Verification

- Start `memoria-server` through Excubitor and verify the catalog health endpoint
  returns a successful response.
