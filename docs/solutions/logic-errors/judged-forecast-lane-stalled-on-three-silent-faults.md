---
title: "The judged forecast lane resolved nothing for six weeks behind three silent faults"
date: 2026-10-06
category: logic-errors
module: scripts/seed-forecast-resolutions
problem_type: logic_error
component: background_job
severity: critical
symptoms:
  - "No judged forecast reached a scored outcome from 2026-08-23 to 2026-10-06"
  - "Every judge-B attempt from 2026-08-29 recorded judge_unavailable or judge_returned_empty (175 of 175)"
  - "Every due judged entry stopped at reason archive_incomplete before any judge was called"
  - "forecast:evidence:coverage:v1 was absent while forecast:evidence:v1 held a healthy archive"
  - "No health signal fired; the seeder kept reporting OK"
root_cause: logic_error
resolution_type: code_fix
related_components: [assistant, development_workflow]
tags: [forecast, judged-lane, llm-judge, coverage-marker, ttl, liveness-proof, health-alarm, groq, openrouter]
---

# The judged forecast lane resolved nothing for six weeks behind three silent faults

## Problem

The judged lane of `seed-forecast-resolutions` resolves forecasts by asking two LLM judges to read archived news evidence. From 2026-08-23 to 2026-10-06 it scored nothing. Three independent faults stacked, and any one of them was enough to stop the lane. The tracking issue is #8877.

## Symptoms

- `forecast:scorecard:v1` `judgedLane` showed 175 of 175 judge-B attempts since 2026-08-29 as `judge_unavailable` or `judge_returned_empty`.
- `forecast:evidence:coverage:v1` was absent when read on 2026-10-06. At that point every due entry stopped at `archive_incomplete` before any judge call. Earlier the two faults overlapped rather than ran in sequence: from 2026-08-29 to 2026-10-05 the attempt log holds 176 `judge_unavailable` attempts (entries that reached judge B) interleaved with 85 `archive_incomplete` attempts.
- The evidence archive itself was healthy: 15,818 records back to 2026-09-21 with no empty 6-hour bucket (per #8877). Only the proof of coverage was missing.
- 195 entries sealed VOID as `beyond_archive_horizon` while this went on (per #8877).
- Nothing alarmed. Seed metadata stayed fresh because the seeder ran on schedule and wrote its ledger.

## What Didn't Work

- **Fixing the judge alone.** Moving judge B off Groq (#8876) was necessary but not sufficient. With the marker gone, entries still stopped at `archive_incomplete` before reaching either judge.
- **Re-running the backfill.** `scripts/backfill-forecast-evidence-archive.mjs` only certifies coverage when its scan is complete. Its dry run on 2026-10-06 reported `truncated: true`, 792 missing rows, and 737 tombstones, so it wrote no marker.
- **Falling back to the digest accumulator.** The resolver's fallback source was permanently holed (about 7,200 missing story-track rows even at `maxHashes: 40000`, per #8877), so it could never prove coverage either.

## Solution

Three fixes, one per fault.

1. **Judge B provider (#8876).** Judge B moved from Groq to OpenRouter `openai/gpt-6-luna` (`JUDGE_B_DEFAULT_MODEL` in `scripts/seed-forecast-resolutions.mjs`). Judge A stays on a different model family so agreement is two independent reads. Groq was then removed repo-wide (#8903, closing #8885).

2. **Coverage marker recovery (#8880).** The marker writer in `server/worldmonitor/news/v1/list-feed-digest.ts` only re-SETs a marker that already exists (`if (evidenceEligible && coverageBefore)`). Once the marker expired, no writer could ever create it again. #8880 adds `recoverForecastEvidenceCoverage` in `scripts/_forecast-evidence-archive.mjs`. It rebuilds a version-2 marker from a complete, untruncated scan of the evidence archive when the oldest record is at least 14 days old and no gap between records exceeds `FORECAST_EVIDENCE_CONTINUITY_BUCKET_MS` (6 hours). The recovered marker is a reader-only attestation. It cannot authorize accumulator pruning, and a conditional write keeps it from overwriting a marker a publisher wrote during the scan.

   Before #8880 deployed, the marker was restored once by operator attestation after the same continuity check by hand.

3. **Lane alarms (#8880).** `buildJudgedLaneHealthPatch` writes lane health into the resolver's seed metadata from `afterPublish`. It raises `coverage_unverified_with_overdue_entries`, `archive_unreadable_with_overdue_entries`, and `no_scored_within_sla_for_3_runs`. The stall counter advances only on runs where the lane had overdue or resolved entries, and it resets on a scored-within-SLA outcome or an idle run. An idle lane does not alarm, and historic successes or VOIDs cannot mask a stall. Since 2026-10-07 the stall is a quality field (`quality.noScoredWithinSlaRuns`) and no longer sets `status: error`; only the two input-read reasons degrade health, because health measures whether the resolver runs, not how well it scores.

Proof of recovery: the 06:01 UTC `seed-forecast-resolutions` run on 2026-10-06 reached both OpenRouter judges with no new `judge_unavailable` attempts and resolved 21 entries (recorded on #8877).

## Why This Works

Each fault was a liveness failure that looked like an idle state.

- An LLM that returns an empty body is indistinguishable from "the judge declined" unless someone counts the rate.
- A TTL'd proof key with a refresh-only writer is a time bomb. Any outage longer than the TTL deletes it, and the code path that would rebuild it requires it to exist. Rebuilding the proof from the archive's own continuity removes the dependency on the holed accumulator.
- Seed freshness proves the job ran, not that it produced outcomes. The new reasons measure the outcome the lane exists to produce.

## Prevention

- For any TTL'd marker or proof key, find every writer and check that at least one can create it from scratch. "Refresh if present" alone is a one-way door.
- Alarm on the output a pipeline exists to produce (scored outcomes), not only on whether it ran. Require N consecutive eligible runs so an idle lane stays quiet.
- Track per-provider empty and unavailable rates for LLM judges. A 100% empty rate from one provider should be an alarm, not a ledger statistic.
- When diagnosing a stalled lane, list every gate an entry passes before the expensive call (marker, archive read, judge) and check each one. Fixing the first fault found can leave the next one in place.

Related: `docs/solutions/best-practices/a-health-metric-must-report-zero-when-it-has-no-basis.md` covers the judged-lane metrics added in #7254.
