# Memoria server startup failure from discord.js version mismatch

- Date: 2026-07-15
- Status: fixed in working tree
- Area: server startup / Discord integration
- Severity: high — the local server does not become healthy after startup

## Summary

This regression stopped Memoria during bootstrap after a restart. At the time of the
incident, the installed `discord.js` version had been downgraded from the v14 range to
v13 while the Discord integration still imported the v14-only `GatewayIntentBits` and
`Partials` exports.

A surviving development watcher could make the service appear started after the
application had crashed, even though its health check was unavailable.

## Evidence

- On 2026-07-15, a local restart left the `tsx watch` launcher running while the
  application failed before binding its health endpoint.
- The server error was:
  `SyntaxError: The requested module 'discord.js' does not provide an export named 'GatewayIntentBits'`.
- `server/discord/intents.ts` imports `GatewayIntentBits` and `Partials`.
- The incident dependency snapshot declared/versioned `discord.js` as `13.17.1`, which
  is incompatible with those imports.

## Regression Context

The service previously ran with the v14-compatible dependency. This is a working-tree
dependency regression exposed by the first restart after the downgrade.

## Cause

Primary cause: a dependency change downgraded `discord.js` to v13 without converting
the Discord integration back to the v13 API.

Operational masking: the surviving watcher/launcher process was not sufficient evidence
that the application had started successfully.

## Fix Requirements

- Restore a dependency/API-compatible Discord.js combination; the committed code expects v14.
- Reinstall dependencies so `node_modules` matches the accepted lockfile.
- Do not overwrite unrelated uncommitted Memoria work when applying the repair.
- Treat a successful health probe, rather than a live watcher alone, as evidence of a
  healthy Memoria server.

## Verification

- Confirm the accepted package manifest and lockfile resolve a Discord.js version that
  exports `GatewayIntentBits` and `Partials`.
- Run the server regression suite after reinstalling dependencies from the accepted
  lockfile.
- Start the server through its normal service manager and confirm its health endpoint
  succeeds after a clean restart.

## Follow-up

Keep the server dependency declaration and lockfile synchronized. Do not record local
process identifiers, local log locations, orchestration claims, or branch hashes in this
repository's incident logs.
