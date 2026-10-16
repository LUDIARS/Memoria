---
task: llm-remaining-periods
project: Mm
kind: feature
created: 2026-10-16
memory_links: []
---

# Remaining-usage history ranges

Instruction: neco requested 3-month / 1-month / 1-week / 1-day / 1-hour views for the weekly-limit graph.
The prior instruction to complete reflection applies to this graph extension.

Design / acceptance (`SPEC-LLM-OBS-REMAINING`):
- Select five rolling windows; 1 month means 30 days, 3 months means 90 days, stated in the UI.
- Default to one week. Keep selection across reloads of the LLM view within the page session.
- Query Cc with the selected start time. Return the selected boundaries and fix the chart axis to those boundaries.
- Preserve missing data. Abort superseded reads; an older response must not overwrite a newer selection.
- Retain the full observation path for long windows without creating a DOM circle for every sample.
- Cc owns history retention. Its existing 60-day limit must be extended to 90 days for limit samples only;
  already deleted history cannot be recovered. No local copy or fabricated observations.

Boundary: supporting `llm-observatory` domain; adapter / HTTP guard / frontend renderer remain separate.
Repository specification: `spec/feature/llm-observatory.md#残り使用量-spec-llm-obs-remaining`.
Base: Memoria `f2fa350`; upstream Cc `src/bootstrap/cost.ts` uses a shared 60-day retention value.
Praeforma has no graph specification entries (Memoria project previously checked at revision 0).
Anatomia prepared domain index and deterministic plan were consulted for `memoria`: `llm-observatory`
and `web-frontend` own this change. Test suggestions recommended primary flow, invalid-input edges,
and API contracts; corresponding adapter tests cover all five periods, inclusive boundaries,
invalid prototype keys, and histories above the former 10,000-row limit.

Verification before submission: TypeScript syntax transformation and whitespace check.
Runtime and browser checks are separate from these static checks; lack of stored older data is not a test failure.
