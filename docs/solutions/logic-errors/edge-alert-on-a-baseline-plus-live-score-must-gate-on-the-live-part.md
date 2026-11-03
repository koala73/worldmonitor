---
title: An edge alert on a score that adds a standing baseline to live signals must fire on the live part, not the score
date: 2026-10-17
category: logic-errors
module: chokepoint-disruption-alerts
problem_type: logic_error
component: background_job
severity: high
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - "Hormuz and Kerch (war-zone baseline 70) already sit in the red band (50+) with no live signal, so a score-threshold alert fires once on the first tick and never again"
  - "Bab el-Mandeb (critical baseline 40) crosses 50 on a single navigational warning and flaps on every tick that adds or drops one"
  - "a retried publish minted a new coalesceKey per attempt, so publisher dedup could not suppress the duplicate"
  - "a malformed Upstash response body reset the saved fired state, re-alerting every red chokepoint"
  - "a reading with disruptionScore null counted as 0 and re-armed a fired chokepoint"
tags:
  - "alerting"
  - "edge-trigger"
  - "hysteresis"
  - "baseline"
  - "coalesce-key"
  - "chokepoints"
  - "notification-relay"
  - "upstash"
related_components:
  - "testing_framework"
---
## Problem

PR #9249 (issue #9217) added a `chokepoint_disruption` alert. The first version fired when `disruptionScore` reached the red band (`scoreToStatus`, `server/worldmonitor/supply-chain/v1/_scoring.mjs:57`). That score is a standing threat level per chokepoint (`THREAT_LEVEL`, `_scoring.mjs:17`: war zone 70, critical 40, high 30) plus live signals: navigational warnings, AIS disruption and a transit drop. A threshold on the sum mixes a constant with the thing worth alerting on.

## Symptoms

- War-zone chokepoints start above 50 with zero live signal. The edge trigger fired on the first tick, before anyone could opt in, then could never fire again, because the score never left the red band.
- Critical-tier chokepoints sit 10 points under the line, so one warning (5 points) plus normal noise crossed it and every wobble paged again.
- Retries and lost state writes produced a fresh `coalesceKey` per attempt, so dedup could not catch them.

## What Didn't Work

- **Threshold on the score with a once-per-crossing latch.** It was correct for chokepoints with a low baseline and wrong for the two that matter most (Hormuz, Kerch). An independent review caught it; unit tests that used a normal-tier fixture had passed.
- **Treating any `readState` parse failure as corrupt state.** `upstashGet` in `scripts/ais-relay.cjs` reports `JSON result parse failed` (stored value is corrupt) and `JSON response parse failed` (the HTTP body was malformed, a transport error). A `/parse/i` match reset state on transport errors too, and the final write overwrote the saved fired entries (CodeRabbit finding).
- **`Number(chokepoint.disruptionScore)` as the finiteness check.** `Number(null)` is `0`, which is finite and reads as fully subsided, so a missing score re-armed a fired chokepoint.

## Solution

All in `scripts/lib/chokepoint-disruption-alerts.cjs`:

1. Split the score: `live = max(0, score - baseline)` (line 52), with the baseline keyed by the response's `warRiskTier`. Fire only when the score is red **and** `live >= LIVE_FIRE_POINTS` (15, line 80).
2. Hysteresis: re-arm only when `score < REARM_SCORE` (40) or `live < 5` (line 69), in a reading where the warning and AIS sources were available, plus transit data if the crossing carried a transit drop. A missing source can only lower the score, so it must not count as "subsided". There is also a 12-hour per-chokepoint cooldown after a fire.
3. State moves armed → pending → fired. A new crossing is written as `pending` with its `crossingAt` (line 84) **before** publishing; every retry republishes that same `crossingAt`, so `coalesceKey = chokepoint_disruption:<id>:<crossingAt>` is stable and the 24-hour publisher dedup suppresses duplicates. If the pending write fails, nothing is published.
4. Only `/JSON result parse failed/` starts fresh (line 135). Every other read failure skips the tick.
5. A score is used only when it is a number or a non-blank string (line 48 comment); `null` becomes `NaN` and the reading is skipped.

The cooldown defers rather than drops: a re-cross inside the window leaves the state `armed`, and the first tick after the window that is still above the line fires. That avoids the failure in [cooldown keyed on time since emission](cooldown-keyed-on-time-since-emission-drops-a-genuine-escalation.md).

## Why This Works

The baseline is a property of the chokepoint, not an event. Subtracting it makes the trigger depend only on what changed, so every tier gets the same sensitivity and a war-zone chokepoint can still alert on new activity. Hysteresis with a dead band (fire at 15 live, re-arm under 5) stops a score oscillating around one threshold from paging. Persisting the crossing id before the side effect turns at-least-once publishing into effectively-once delivery through the existing dedup.

Verified in production on 2026-10-17: the first warm-ping after deploy published one event, `Strait of Hormuz: disruption score 85/100` (70 baseline + 15 live). The notification relay processed it as critical; no rule had opted in yet.

## Prevention

- When a score is `baseline + signals`, test the alert with a fixture at **each** baseline tier, including one that starts above the threshold with no signal. `tests/chokepoint-disruption-alerts.test.mjs` covers the war-zone case ("can alert on a war-zone chokepoint whose standing level is already red") and the critical case ("does not fire on one warning above a critical-tier baseline").
- Pin a wobble sequence: scores `55, 50, 55, 50, 55, 45, 55` must fire once.
- Pin both failure paths of the id: a failed publish and a lost post-publish write must both reuse the first `coalesceKey`.
- Classify Redis read errors by message, not by a broad regex, and test the transport case explicitly ("treats a malformed Upstash response body as a read failure, not corrupt state").
- Never use `Number(x)` alone to decide a value is present; `null`, `''` and `false` all become `0`.

Operational notes from the rollout:

- `ais-relay` delays its first warm-ping by up to 30 minutes after each boot when the data is fresh, and every Railway redeploy restarts that delay. A burst of merges to main can postpone the first run of new producer code by more than an hour.
- Read the live deployment's logs by `deploymentId`. A service-scoped log query can return the logs of a newer `SKIPPED` deployment and show nothing.
- `processEvent` in `scripts/notification-relay.cjs` returns silently when no rule matches. A "Processing event" line with nothing after it means no opted-in rule, not a delivery failure.
