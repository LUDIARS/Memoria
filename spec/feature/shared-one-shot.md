# Shared one-shot CLI boundary

The ai-hub boundary routes local Claude print and Codex exec jobs through
Lapilli's `@ludiars/one-shot`, linked from the pinned `lib/lapilli` submodule.
Gemini keeps its native process path; API and Concordia delegation paths keep
their existing transport contracts. Service-runtime owns the extracted shared
CLI response runner, including stream handling, deadlines and Codex decoding.

Claude task defaults use centrally resolved roles, preserving the 1M context
suffix for long-form jobs. Codex defaults use the central Sol role and do not
inherit Claude task defaults. Explicit configured IDs remain overrides.
Request and agent-run records contain the resolved model. Caller permissions,
working directories, prompts, cancellation and visible errors remain owned by
Memoria. No retry, live inference or service restart is added.

Revisor initializes the Lapilli submodule before dependency installation and
runs the registered server checks. Rollback restores consumers, dependency
locks and the gitlink together. ESM runtime requires the existing Node 24.
