---
task: llm-history-navigation
project: Mm
kind: feature
created: 2026-10-16
memory_links: []
---

# Even time ticks and navigable remaining-limit history

Instruction: neco requested evenly spaced time labels below the graph, arbitrary starting
position, and left/right navigation by the selected duration. The existing request to
complete reflection applies to this extension of the same graph.

Value / acceptance: `SPEC-LLM-OBS-HISTORY-NAV` in `spec/feature/llm-observatory.md`.
Supporting domain: `llm-observatory`; the frontend time-window rules are a pure module.
State owner: Cc owns observed history; Memoria owns the selected window in page memory.

- Display equal time and position intervals across the complete axis, including empty periods.
- Date input means JST independently of the browser timezone; invalid dates are rejected.
- Previous/next shifts by the entire selected span. Latest clears the explicit start.
- Preserve a full axis for a window that extends past now, but never display future observations.
- API `from` is a nonnegative integer epoch second at or before now. Invalid inputs return 400.
- Existing cancellation and stale-response guards remain in place. Loading controls cannot shift
  using a different duration from the currently selected one.

Base: Memoria `6c46504`. Read the current frontend and guarded remaining-usage API.
Anatomia plan endpoint was attempted but connection was refused; it was not started.
Used the previously supplied domain map and the repository's current specification and source.
Praeforma had no specific graph specification at the last checked Memoria revision (0).

Validation before submission: whitespace and TypeScript syntax checks. Added contract tests for
historical start/end filtering, future-observation exclusion, and malformed start values, plus
pure frontend tests for equal tick spacing, JST midnight and invalid dates, and reversible
navigation for all five durations. Runtime and visual verification are separate post-merge checks.
Recovery: revert this commit; no schema or stored-history change.
