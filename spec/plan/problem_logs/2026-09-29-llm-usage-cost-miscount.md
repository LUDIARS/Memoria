# LLM observatory misprices Opus 5.5 and undercounts streamed usage

- Date: 2026-09-29
- Status: fixed in branch `feat/llm-usage-cost-fix`
- Area: LLM observatory (`server/llm-usage/`)
- Severity: medium (displayed estimate only; no billing or external effect)

## Summary

The LLM tab's cost and token figures did not match the official price pages or the
native logs. The figures are an API list-price estimate, but the gaps were large enough
to break a weekly audit.

## Evidence

- `price-table.ts` priced `claude-opus-5-5` through the `claude-opus-5` pattern at
  $5 / $25 with a shared 0.1x cache-read multiplier. The official rates are $4 / $20,
  5m write $5, 1h write $8, read $0.20 (0.05x).
- GPT-6 Astra / Sol had no rate (counted as $0) and older Codex models were priced with
  Claude proxy rates.
- The Claude parser kept the first row per `message.id`. Claude Code writes one row per
  streamed content block, and `output_tokens` grows across them, so output was undercounted.
- Copied history (resume / fork) and subagent logs were deduplicated only within one file.
- Codex `archived_sessions/` was never read.
- Missing TTL breakdowns were assumed to be 5-minute writes.
- The dashboard's weekly window used a UTC `date('now')`. The session list was limited to 500 rows,
  and no view summed a selected period.
- A rate change never re-priced stored rows, because the source cache is keyed by mtime / size.

## Cause

Usage was aggregated per source file and per day at parse time. Response identity and
the price used were therefore lost before storage, so fragments, copies, and rate changes
could not be reconciled afterwards.

## Fix

Responses are stored one row per provider response with a versioned cost breakdown. Parser and
rate-table versions trigger re-reads and re-pricing. Period totals are computed in SQL over all rows
(see `spec/feature/llm-observatory.md`).
