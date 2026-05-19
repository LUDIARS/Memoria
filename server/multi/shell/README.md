# Memoria Hub — Shell (placeholder)

This directory is a **Phase 0 placeholder** for the Hub Shell (frontend
aggregator for multiple LUDIARS apps). See
[`spec/feature/hub-shell.md`](../../../spec/feature/hub-shell.md) for the
design.

Phase 0 ships only:

- this README
- `apps.example.json` — example app registry (multiple apps in one bootstrap file)
- `well-known.example.json` — example of what a single app exposes at
  `/.well-known/ludiars-app.json` for Hub self-registration (§9.1)
- `registry.schema.sql` — proposed Postgres DDL for the `hub_apps` table
  used by the self-setup UI (§9.3) — NOT a real migration yet

No mount loader, no shell SPA, no integration with `server/multi/index.js`
yet. Phase 1 starts once the bundle method (§3 of the spec) is decided.

The shell is kept self-contained under this directory so it can later be
extracted into a separate `LUDIARS Shell` service without entangling with
Memoria-specific code.
