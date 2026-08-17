---
module: seed-bundle-runner
date: 2026-08-13
problem_type: logic_error
component: background_job
severity: critical
symptoms:
  - Railway paints `seed-bundle-resilience` SUCCESS every tick while every section is deferred and nothing publishes
  - The startup admission guard passes a section sized at exactly `maxBundleMs - KILL_GRACE_MS`, which the runtime check then rejects on every tick
  - "`findUnadmittableSections([{timeoutMs: 560_000}], 570_000)` returns `[]` even though the section can never be admitted"
  - A seed-meta staleness alarm is the only signal that surfaces six hours of silent non-publication, ~14h after the fact
root_cause: logic_error
resolution_type: code_fix
related_components: [tooling, testing_framework]
tags: [green-while-dead, admission-gate, budget-headroom, runtime-cost-blind-spot, railway-cron, static-config-gate, silent-pass, seed-bundle-runner]
---

# A static admission gate that ignores the runtime's own pre-consumption admits configurations that can never run

## Problem

`scripts/_bundle-runner.mjs` gives Railway cron bundles an optional wall-time budget. A section is admitted only when its worst case still fits the budget that is left:

```js
// scripts/_bundle-runner.mjs:413-425
const elapsedBundle = Date.now() - t0;
const worstCase = sectionWorstCaseMs(section);
if (elapsedBundle + worstCase > maxBundleMs) { /* deferred */ }
```

Worst case is `timeoutMs + KILL_GRACE_MS`, and `KILL_GRACE_MS` is `10_000` (`scripts/_bundle-runner.mjs:130`, `scripts/_bundle-runner.mjs:137-139`).

PR #6531 shipped `seed-bundle-resilience` with `maxBundleMs: 570_000` against sections declared at `600_000`, `900_000` and `600_000`. The cheapest section therefore needed `610_000`ms of a `570_000`ms budget. No section could be admitted on any tick, ever.

Deferral is load-shedding, not failure. It was counted in no exit path, so the bundle exited 0 on every tick, Railway painted SUCCESS, and the service published nothing for six hours (issue #6556). The first alarm was seed-meta staleness at `maxStaleMin: 840`, about fourteen hours after the service stopped working.

## Symptoms

- Production log of the active deployment, in full, on every cron tick:

  ```
  [Bundle:resilience] Starting (3 sections, budget 570s)
    [Resilience-Scores] Deferred, needs 610s (timeout+grace) but only 570s left in bundle budget
    [Resilience-Static] Skipped, last seeded 64442min ago (interval: 129600min)
    [Food-Stocks] Deferred, needs 610s (timeout+grace) but only 570s left in bundle budget
  [Bundle:resilience] Finished in 0.1s, ran:0 skipped:1 deferred:2 failed:0 graceful:0
  ```

  Exit code 0. Railway badge green. `diagnose-railway-seeders` reported `HEALTHY — Currently green; last run clean`.
- `Finished in 0.1s` for a bundle whose one due member normally takes 5.7s of real work. The tick was over before it began.
- No Redis write: `seed-meta:resilience:scores` stayed at `2026-08-13T06:01:55Z`, the last tick on the previous image.
- The section being starved for a 610s window measures ~5.7s warm and 1-2 min cold. The declared timeout was two orders of magnitude above the real cost, which is what made it unadmittable.
- Nothing detected it for six hours. Detection finally came from key expiry (`resilience:ranking:v27`, 12h TTL), not from the service.

## What Didn't Work

The first fix in PR #6564 added a startup guard so a section that cannot fit the whole budget is rejected before anything spawns, instead of being deferred forever in silence. The predicate was:

```js
// first attempt
export function findUnadmittableSections(sections, maxBundleMs) {
  if (!Number.isFinite(maxBundleMs)) return [];
  return sections.filter((section) => sectionWorstCaseMs(section) > maxBundleMs);
}
```

That guard carries the same defect it was written to catch. Put the two inequalities side by side:

| | Test | Admits |
|---|---|---|
| Static gate (startup) | `worstCase > maxBundleMs` rejects | `timeoutMs <= maxBundleMs - KILL_GRACE_MS` |
| Runtime check (per section) | `elapsed + worstCase > maxBundleMs` defers | `timeoutMs <= maxBundleMs - KILL_GRACE_MS - elapsed` |

The two boundaries differ by `elapsed`, and `elapsed` is never zero. The freshness gate runs before the budget check, in the same loop body: `readSectionFreshness` at `scripts/_bundle-runner.mjs:401`, the budget test at `scripts/_bundle-runner.mjs:419`. That gate makes up to three Redis reads per section — `canonicalKey` (`scripts/_bundle-runner.mjs:87`), `freshnessMetaKey` (`scripts/_bundle-runner.mjs:89`), `completionMetaKey` (`scripts/_bundle-runner.mjs:93`) — each one bounded by `REDIS_READ_TIMEOUT_MS` (`scripts/_bundle-runner.mjs:55`, applied at `scripts/_bundle-runner.mjs:62`).

So a section sized at exactly `maxBundleMs - KILL_GRACE_MS` passed the new startup guard and was still deferred on every tick, forever, exiting 0 — #6556 surviving its own fix. Against the real config, the guard admitted every `timeoutMs` up to `560_000` for a `570_000` budget, while the runtime admitted none of them.

Three independent reviewers found this, one from a different model family that verified it by execution rather than by reading: `findUnadmittableSections([{ timeoutMs: 560_000 }], 570_000)` returned `[]`.

The issue itself prescribed the same wrong threshold. Acceptance criterion 3 of #6556 reads "for each section, `timeoutMs + KILL_GRACE_MS <= maxBundleMs`". The first fix implemented the stated criterion faithfully, and the criterion was the bug.

Two smaller versions of the same silent-pass shape were fixed in the same round:

- The repo-wide gate's anti-vacuity check compared `extractBundleSections(...).length` against a count derived from the *same* regex. It only proved the extractor agreed with itself: a section the anchor cannot see is absent from both counts, the equality holds, and the gate passes on a bundle it never read. It now counts `script:` with a deliberately different token (`tests/helpers/bundle-section-parser.mjs:177`, asserted at `tests/bundle-budget-admission.test.mjs:128-133`).
- `starvedTick` first fired on `ran:0 && deferred > 0` alone. That paged on a benign upstream 429: the only admitted section exits 75, the last-good TTL is extended, no data is lost, yet Railway prints "Deploy Crashed!". It is narrowed with `gracefulFailed === 0` at `scripts/_bundle-runner.mjs:478`.

## Solution

Derive an explicit headroom constant from the runner's own pre-admission cost, and use the same constant in the runner and in the CI gate.

Before:

```js
export function findUnadmittableSections(sections, maxBundleMs) {
  if (!Number.isFinite(maxBundleMs)) return [];
  return sections.filter((section) => sectionWorstCaseMs(section) > maxBundleMs);
}
```

After (`scripts/_bundle-runner.mjs:154-167`):

```js
export const REDIS_READ_TIMEOUT_MS = 5_000;                 // scripts/_bundle-runner.mjs:55
export const ADMISSION_HEADROOM_MS = 3 * REDIS_READ_TIMEOUT_MS;

export function findUnadmittableSections(sections, maxBundleMs) {
  if (!Number.isFinite(maxBundleMs)) return [];
  return sections.filter(
    (section) => sectionWorstCaseMs(section) + ADMISSION_HEADROOM_MS > maxBundleMs,
  );
}
```

The `3 *` is not a taste call: it is the number of Redis reads `readSectionFreshness` can make before a section reaches the budget test (`scripts/_bundle-runner.mjs:83-98`). `REDIS_READ_TIMEOUT_MS` is the same constant the `AbortSignal` uses, so the headroom cannot drift away from the cost it stands for.

`runBundle` throws on a violating config before spawning anything, and names the remedy (`scripts/_bundle-runner.mjs:367-380`):

```js
const unadmittable = findUnadmittableSections(sections, maxBundleMs);
if (unadmittable.length > 0) {
  const largestFittingTimeoutMs = maxBundleMs - KILL_GRACE_MS - ADMISSION_HEADROOM_MS;
  throw new Error(/* ... 'NEVER' needs 585000ms (timeoutMs 560000 + 10000ms kill grace + 15000ms admission headroom) ... */);
}
```

Three further changes close the routes around it:

1. A declared-but-unusable budget throws instead of reading as "no budget" (`scripts/_bundle-runner.mjs:351-356`). Every guard is gated on `Number.isFinite(maxBundleMs)`, so `maxBundleMs: '570000'` or a `NaN` from `Number(process.env.X)` would disable the startup check *and* the per-tick deferral — the same outage by a different route.
2. A tick that admitted nothing while deferring due work exits non-zero (`scripts/_bundle-runner.mjs:478-490`). `ran:0 deferred:>0` is otherwise indistinguishable from a healthy no-op in Railway's badge, which is what hid #6556 for six hours.
3. The section timeouts were right-sized to measured runtime, with the measurement written down next to each number (`scripts/seed-bundle-resilience.mjs:31`, `:35`, `:40`): `240_000` / `420_000` / `480_000` against `maxBundleMs: 570_000` (`scripts/seed-bundle-resilience.mjs:48`). The cheapest now needs `265_000`ms of `570_000`ms. The file also records why a timeout above Railway's 10-minute cap never bounded anything: the container is SIGKILLed first, taking the logs with it (`scripts/seed-bundle-resilience.mjs:12-18`).

`tests/bundle-budget-admission.test.mjs` is the repo-wide tripwire. It parses every `scripts/seed-bundle-*.mjs` statically and applies the runner's own threshold, headroom included (`tests/bundle-budget-admission.test.mjs:184`):

```js
if (section.worstCaseMs + ADMISSION_HEADROOM_MS <= bundle.maxBundleMs) continue;
```

It calls `sectionWorstCaseMs` from the runner rather than restating `timeoutMs + KILL_GRACE_MS` (`tests/bundle-budget-admission.test.mjs:147-150`), and it also asserts each budget is below Railway's 600_000ms container cap (`tests/bundle-budget-admission.test.mjs:109-113`) — nothing checked that, so a 900_000 budget satisfied every per-section assertion while the container still died mid-publish. All six budgeted bundles pass (3/3 tests green, 246ms).

## Why This Works

A budget is spent by more than the thing being budgeted. The runtime check consumes the budget *incrementally* — `elapsed` grows across the loop, and it is already non-zero at the first section because the freshness gate ran first. A static gate that compares only the item's own cost against the total is answering a different question from the one the runtime asks. The gate's answer is optimistic by exactly the amount the runtime consumes before it asks.

The general form: **any static gate over a budget that a runtime check consumes incrementally must reserve the runtime's own pre-consumption, or it admits a band of values the runtime rejects.** The width of that false-admit band is the pre-consumption. Here it was `elapsed`, up to 15s of Redis reads, and every `timeoutMs` in `(545_000, 560_000]` sat inside it.

The reservation must be *derived*, not chosen. `ADMISSION_HEADROOM_MS = 3 * REDIS_READ_TIMEOUT_MS` is written in terms of the consumer's own constant and the consumer's own read count. If someone raises the Redis timeout, the headroom moves with it and the gate stays honest. A magic `15_000` would have been correct on the day it was written and silently wrong afterwards — a second copy of the same class of drift that produced the original bug, where `maxBundleMs` was picked without reference to `KILL_GRACE_MS`.

Deriving it also makes the gate and the runner share one source of truth. `findUnadmittableSections` is exported and used by both the runner (`scripts/_bundle-runner.mjs:367`) and CI (`tests/bundle-budget-admission.test.mjs:184` uses the same exported constants), so the static threshold and the runtime threshold cannot disagree about which sections are admittable.

## Prevention

**The diagnostic.** When a static gate and a runtime check test the same budget, write both inequalities down side by side and solve each for the boundary value:

```
gate    admits  x  <=  B - c1
runtime admits  x  <=  B - c1 - c2      (c2 = whatever the runtime spent first)
```

If the gate's boundary is a value the runtime rejects, the gate is lying, and the size of the lie is `c2`. Then ask the question that finds `c2`: **what has already run by the time the runtime check executes?** Read the code path from the top of the loop body to the check itself, not just the check. In this case three lines separated the freshness gate from the budget test, and those three lines were the entire bug.

This shape has nothing to do with Railway or seed bundles. It appears wherever a config-time validator and a request-time enforcer share a limit: an upload size validated against `maxBodyBytes` while the server has already buffered headers; a retry budget checked against a deadline that the connect phase already consumed; a queue admission test against a memory cap that ignores per-worker overhead; a rate limiter that validates a configured burst against a window the handler has already partly spent.

**The test shape.** Pin *both* boundary directions. A gate that rejects everything passes a one-sided rejection test for entirely the wrong reason, and so does a gate that admits everything on the acceptance test:

- `tests/bundle-runner.test.mjs:694-713` — a section at exactly `maxBundleMs - KILL_GRACE_MS` (50s timeout, 60s budget) must be rejected at startup, with the fixture asserting `must-not-run` never appears in output.
- `tests/bundle-runner.test.mjs:715-731` — a section with headroom to spare (34s timeout, 60s budget: 34 + 10 + 15 = 59) must be admitted and must actually run. This is the assertion that proves the rejection above is arithmetic rather than blanket refusal.

**Three more habits this round earned:**

- Do not implement a stated acceptance criterion without checking its arithmetic. #6556's criterion 3 encoded the same off-by-`elapsed` error, and a faithful implementation reproduced the bug.
- An anti-vacuity check must use a different token from the extractor it checks. Two counts derived from one regex agree with each other in exactly the case where both are blind (`tests/helpers/bundle-section-parser.mjs:168` vs `:177`).
- A static parser that can return a *wrong* number is worse than one that returns none, because a wrong smaller timeout is one a budget gate happily passes. `extractBundleSections` drops any section using a nested, shorthand, or spread `timeoutMs` (`tests/helpers/bundle-section-parser.mjs:242-245`), and the caller's independent `script:` count then fails loudly on the dropped section.

## This is the third fix to the same exit-code contract

The durable signal is the recurrence, not any one bug. Three separate
corrections have now landed on `_bundle-runner.mjs`'s answer to "did real work
happen?", each a different mechanism reaching the same wrong exit code:

- **#5077 / #5078** — a member's graceful exit-75 was counted in the same
  `failed` tally as a hard crash, so one transient upstream blip crashed the
  whole bundle. Fixed by splitting `gracefulFailed` out so only hard failures
  gate the exit code. That fix has no entry here; it survives only as a note.
- **#6483** — a different mechanism (a stale image, because the build was
  skipped) with the same shape: the service was wrong for ~24 hours and the only
  detector was a downstream staleness alarm.
- **#6556** — this one. Admission arithmetic made every member permanently
  unadmittable and the bundle reported success forever.

Two things follow. First, treat any change to this file's exit-code switch as
high-risk by default and enumerate the states that deliberately do *not* alarm,
asking what else lands in that bucket — that question is what found the
`ran:0 deferred:>0` hole. Second, the fixes compose and must be checked against
each other rather than in isolation: the `starvedTick` exit added here would
have re-broken #5077 if it had fired on a graceful-only tick, which is why it
carries `gracefulFailed === 0` and why a test asserts the graceful exemption
still holds.

## Related Issues

- Issue #6556 — P1, the silent stall (fix in PR #6564, branch `fix/6556-bundle-budget-admission`).
- PR #6531 — introduced `maxBundleMs: 570_000` alongside the `Food-Stocks` section.
- `docs/railway-seed-consolidation-runbook.md` — now records the resilience bundle's wall budget, the per-section values, and the ceiling a new timeout must respect.

## Related Learnings

- `docs/solutions/design-patterns/primary-fallback-inversion-budget-transfer.md` — closest mechanical sibling: time-budget arithmetic that ignores the real shared clock, in a different system.
- `docs/solutions/logic-errors/a-check-gate-that-rebuilt-its-expectation-from-the-artifact-it-was-checking.md` — same "gate reports green while broken" family, different root cause (circular self-reference rather than a missing term).
- `docs/solutions/logic-errors/pre-push-green-tree-cache-attested-a-tree-the-gates-never-ran.md` — same family: an automation reports success over work it never performed.
- `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md` — the repo convention this round exercised: every guard written to catch something must be mutation-tested until it goes red.
- `docs/solutions/integration-issues/merged-is-not-ran-long-cron-seeders.md` — same infrastructure area and the same detection gap: only a staleness alarm catches it.
- Issue #6562 — follow-ups deliberately scoped out of the fix (unmeasured `Resilience-Static` timeout, its orphaned lock on SIGTERM, the unbounded laggard phase, and per-section starvation while the bundle still reports success).
