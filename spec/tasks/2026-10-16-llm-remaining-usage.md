---
task: llm-remaining-usage
project: Mm
kind: feature
created: 2026-10-16
memory_links: []
---

# Cc subscription remaining usage in the LLM tab

Human instruction: neco requested displaying Cc's existing remaining-usage graph in Memoria's LLM tab (2026-10-16 conversation). This is authorization to implement the feature; no separate start confirmation is needed.

Value / acceptance: `SPEC-LLM-OBS-REMAINING` in `spec/feature/llm-observatory.md`.
Show Claude and Codex weekly and short-window remaining percentages, seven days of history,
observation time, reset time, unknown windows, and independent load/retry errors.

Domain: `llm-observatory` (supporting domain; existing native-log cost accounting is unchanged).
Cc owns the observations; Memoria provides a guarded, read-only adapter and a dedicated frontend renderer.
No provider credential access, database migration, persistent polling, or stored limit-history copy.
Invariant: missing observations never become a fabricated remaining percentage; upstream private fields are not forwarded.
Spec references: `spec/feature/llm-observatory.md#残り使用量-spec-llm-obs-remaining` and `#プライバシー観点`.

Evidence consulted:
- Memoria local main `ead8ce0`, `server/llm-usage/router.ts`, `server/public/src/llm-view.ts`, and the existing observatory specification.
- Concordia `b39c9600`, `src/api/cost.ts` (`/limit-timeseries`), `src/cost/limit-sampler.ts`, and `web/src/pages/CostFeed.tsx`.
- Read-only Cc API response contained 1,982 observations for the previous seven days; Codex short-window data was null, so the UI must preserve unknown values.
- Praeforma registered Memoria project `01M3FVMFYM9KR9N90D4CW1X9JJ`: specification list empty; version `0.0.0`, revision 0. No specific approved graph specification was available there. Repository specification is authoritative.
- Anatomia registered project `memoria`, HTTP `/api/context`: retrieved context and observatory references. The initial CLI invocation could not write its user registry under the sandbox; HTTP context succeeded without changing that registry.

Validation: whitespace check and TypeScript syntax transformation performed. Contract tests were added
(`npm run test:llm-remaining`) for upstream failure, null preservation, response field allowlisting,
bounded history selection, and invalid credential-bearing URLs. Tests and service startup were not run by this session;
Revisor owns review/validation. Runtime UI rendering and deployment remain to be verified after merge.
Recovery: revert the feature commit; no data migration or persistent state is introduced.
