# Task triage review exposed private API and stale-update gaps

- Date: 2026-09-03
- Status: fixed in working tree
- Area: task triage API and task mutation semantics
- Severity: high

## Summary

PR #1241 introduced a local-only task-triage API without the repository's same-machine/origin guard. It also accepted stale decisions after a task had changed, validated deadline strings by shape only, and bypassed the normal task-update journal and ownership side effects.

## Evidence

- `server/task-triage/router.ts` mounted read, mutation, and LLM-triggering routes without `isSameMachineRequest`, while the application-wide API CORS policy permits cross-origin requests.
- `server/task-triage/session.ts::decideTask` checked only session membership before writing, so an externally added deadline could be overwritten by a stale completion action.
- `normalizeDueAt` accepted values such as `2026-99-99` and `2026-09-03T29:72`.
- Triage called the low-level `updateTask` directly instead of applying the diary/activity and AI-to-human ownership behavior used by `PATCH /api/tasks/:id`.

## Regression Context

This is a pre-merge review finding, not a known production regression. Existing protected browser APIs already use the proxy-aware same-machine guard, but the new API did not follow that boundary.

## Cause

The new router and session layer implemented storage mutations directly rather than reusing the established access-control and task-mutation contracts.

## Fix Requirements

- Guard every task-triage endpoint against remote and cross-origin callers.
- Reject stale task actions with a conflict and preserve the newer task state.
- Validate real calendar dates and clock ranges.
- Apply task changes and their journal/ownership side effects consistently and atomically.
- Keep AI prompt dates and generated deadlines on the same local calendar.

## Verification

Registered tests cover remote/cross-origin rejection, stale-state conflicts, leap-year and time boundaries, mutation side effects, and local prompt dates. Tests were not run because the Revisor review instructions permit file reads and edits only.

## Follow-up

Exercise the task-triage panel in a browser to confirm session controls, AI-prefilled dates, and board refresh behavior remain usable.
