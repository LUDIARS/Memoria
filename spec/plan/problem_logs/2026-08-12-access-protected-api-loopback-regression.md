# Access-protected APIs still required direct loopback

- Date: 2026-08-12
- Status: fixed in working tree
- Area: browser API access control
- Severity: user-visible regression

## Summary

Memoria returned `{"error":"direct loopback access required"}` when its browser UI was opened through the Access-protected host. The same error had been fixed for Clever Search on 2026-08-06, but LLM usage, spending logs, and personality-export management still used the older direct-loopback guard.

## Evidence

- `server/llm-usage/router.ts` and `server/spending-log/router.ts` applied `isDirectLoopbackRequest` to every route.
- `server/routes/personality-export.ts` applied it to settings and token lifecycle mutations.
- The running service log recorded `403` responses for browser asset requests through the external route on 2026-08-12T03:13:55Z.

## Regression Context

`2026-08-06-clever-search-loopback-host-rejection.md` records the same browser topology problem. Its resolution did not cover these three API families.

## Cause

The application retained peer-address and URL-host loopback checks even though Access is the designated browser authentication boundary. Access forwards valid authenticated requests, so they do not meet the direct-loopback contract.

## Fix Requirements

- Replace the direct-loopback requirement on LLM usage, spending-log, and personality-export browser APIs with the proxy-aware same-machine guard, which accepts the configured Access hostname while preserving local-peer and same-origin checks.
- Keep the Quaestor upstream URL validation and agent-run token guard unchanged; they are separate trust boundaries.
- Document that Access is the authentication boundary for these browser APIs.

## Verification

Regression tests now assert that Access-forwarded browser requests reach the three API families, while direct remote and cross-site requests remain rejected. No tests were executed in this session by instruction.
