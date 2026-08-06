# Clever Search rejected a same-machine hostname

## Incident

On 2026-08-06 the Clever Search UI returned:

```json
{"error":"direct loopback access required"}
```

The browser and Memoria were running on the same Windows machine, but the UI was
opened through the machine hostname, one of its interface addresses, or the
CF Access protected `memoria.ai-run-do.com` host instead of `localhost` /
`127.0.0.1`.

## Cause

The API guard required both the peer address and the URL hostname to be literal
loopback values. This rejected a request that stayed on the same machine whenever
the operator used the machine's normal name or local interface address.

## Resolution

Clever Search now has a same-machine guard. It accepts only peers whose address
belongs to this machine and only URL hosts that are loopback, the OS hostname, or
one of this machine's interface addresses. A repository-owned, non-secret static
config admits the CF Access protected `memoria.ai-run-do.com` host by exact match.
Requests with a mismatched `Origin`, non-allowlisted DNS hostnames, and clients on
other LAN machines remain blocked.

The same-origin check honors Cloudflare's `X-Forwarded-Proto: https`, so TLS
termination does not compare the browser's HTTPS origin with the tunnel's HTTP
upstream URL.

The stricter direct-loopback helper remains unchanged for personality export,
agent execution, and spending-log routes.

## Regression condition

- Same-machine and explicitly allowlisted hostname requests with a matching
  `Origin` are accepted.
- Cross-origin, arbitrary-host, and other-machine requests remain `403`.
