---
title: "get_keyword_spikes advertised a 48-hour baseline while its capped fetch sampled ~2 hours"
date: 2026-07-28
category: logic-errors
module: api/mcp/registry/nlp-tools.ts
problem_type: logic_error
component: assistant
severity: high
symptoms:
  - "get_keyword_spikes (api/mcp/registry/nlp-tools.ts, extracted from rpc-tools.ts) divided per-keyword story counts by a hardcoded KEYWORD_SPIKE_BASELINE_MS (48h) while the ZRANGE feeding it was capped at LIMIT 0 800 over digest:accumulator:v1:full:en"
  - "At real production volume (~350-440 stories/hour per scripts/lib/story-track-batch-reader.mjs) the newest 800 entries span only ~2 hours, so almost every term's baseline count computed to ~0 and the spike decision fell through to the cold-start rule"
  - "Multipliers inflated by roughly the ratio of the assumed 48h span to the ~2h actually sampled (~23x), while the tool response's baseline_hours field still reported a flat 48"
  - "Nothing failed loudly: the cap (KEYWORD_SPIKE_MAX_STORIES) and the window constant (KEYWORD_SPIKE_BASELINE_MS) each looked correct read in isolation, and the mismatch only surfaced by joining the cap against the accumulator's real fill rate"
  - "Caught pre-merge by three independent reviewers, including a cross-model pass, on PR #5734 (issue #5697) before any of this reached production"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [mcp, keyword-spikes, baseline-window, capped-fetch, redis-zrange, digest-accumulator, derived-statistic, code-review-catch]
---

# A per-call fetch cap silently narrowed the window a baseline claimed to cover

## Problem

`get_keyword_spikes` — the MCP tool added in [PR #5734](https://github.com/koala73/worldmonitor/pull/5734) for issue #5697 — reports trending keyword, CVE, and APT/FIN spikes by comparing a recent-window story count against a per-window baseline rate. It reads the story corpus out of the 48-hour digest accumulator with a single capped, newest-first range query (`api/mcp/registry/nlp-tools.ts:443-447` — the tool was later extracted from `rpc-tools.ts` into its own registry module, so line references here point at that module):

```ts
const zres = await redisPipeline([[
  'ZRANGE', DIGEST_ACCUMULATOR_KEY_MCP,
  String(nowMs), String(nowMs - KEYWORD_SPIKE_BASELINE_MS),
  'BYSCORE', 'REV', 'WITHSCORES', 'LIMIT', '0', String(KEYWORD_SPIKE_MAX_STORIES),
]]) as Array<{ result?: unknown }> | null;
```

`KEYWORD_SPIKE_MAX_STORIES` is 800 (`api/mcp/registry/nlp-tools.ts:42`) and `KEYWORD_SPIKE_BASELINE_MS` is 48h, annotated `// digest:accumulator retention` (`api/mcp/registry/nlp-tools.ts:40`). As originally written — in the commit that first added the tool, before the review fix later in the same PR — that 48h constant was handed to the spike math as the baseline span and echoed back to the caller as the tool's `baseline_hours`:

```ts
const spikes = computeKeywordSpikesFromStories(stories, {
  nowMs,
  windowMs,
  baselineSpanMs: KEYWORD_SPIKE_BASELINE_MS,   // <- assumed, never measured
  minSpikeCount: minCount,
  spikeMultiplier: DEFAULT_SPIKE_MULTIPLIER,
});
```

The two constants are individually correct and jointly wrong. The accumulator does retain 48 hours — but on the production feed it carries roughly 17,000-21,000 story hashes in that window (`scripts/lib/story-track-batch-reader.mjs:10-18`, a comment written for the digest cron's chunked reader, not for this tool). That is ~350-440 stories per hour, so `REV ... LIMIT 0 800` returns only the newest **~2 hours** of the accumulator, never 48.

The divisor built from the assumed span lives in the shared core (`shared/keyword-spike-core.js:164`):

```js
const baselineWindows = Math.max(1, (baselineSpanMs - windowMs) / windowMs);
```

With the default 2h window and an assumed 48h span, `baselineWindows` is 23. Every term's pre-window count was then divided by 23 (`shared/keyword-spike-core.js:189`) despite having been drawn from a ~2h sample, of which the recent window itself consumed most.

## Symptoms

None were loud. That is the whole point of the class.

- **Baselines collapsed to ~0.** With only ~2h fetched and a 2h recent window (`shared/keyword-spike-core.js:181-182` splits each story into `recent` or `baselineCount`), almost nothing landed on the baseline side, and what did was divided by 23.
- **The decision degenerated to cold start.** `evaluateSpikeDecision` falls back to `recentCount >= minSpikeCount` whenever `baseline` is 0 (`shared/keyword-spike-core.js:139-141`). The strict `recentCount > baseline * spikeMultiplier` test — the thing that makes a "spike" mean something — effectively stopped running, so the tool degraded into "any term mentioned 5+ times in 2 hours".
- **Reported multipliers inflated ~23x** on the terms that did retain a nonzero baseline, because `multiplier = recentCount / baseline` (`shared/keyword-spike-core.js:138`) inherits the same bad divisor.
- **The response confidently advertised the wrong provenance.** It returned `baseline_hours: 48` and described `story_count` as "Stories in the 48h accumulator sample this computation saw" — a claim about coverage the code had no evidence for.
- Nothing threw, nothing timed out, no Sentry event, no degraded-path note. The output was well-formed, plausible, and quietly wrong.

## What Didn't Work

This never shipped — it was caught in code review on the PR branch, by three independent reviewers including a cross-model adversarial pass run through a different model family. So the honest "what didn't work" is about **what failed to detect it**, and that list is more useful than a debugging narrative.

- **Reading either constant on its own.** `KEYWORD_SPIKE_MAX_STORIES = 800` is a defensible per-call bound for an edge function with a 16KB output budget. `KEYWORD_SPIKE_BASELINE_MS = 48h` is a factually accurate statement about accumulator retention. Review that inspects the cap in the query and the span in the math *separately* signs off on both. The bug exists only in the join.
- **The unit tests, all of them.** The `get_keyword_spikes` fixture seeded 35 stories — 5 recent plus 30 baseline (`tests/mcp-nlp-tools.test.mjs:351-368`). The chunk-boundary test seeded 450 (`tests/mcp-nlp-tools.test.mjs:447-461`). Both sit under the 800 cap, so **the cap never engaged in any test**, and with a 32h-deep fixture the assumed 48h divisor produced results close enough to right that nothing looked off. A cap that is never hit is a code path that is never tested, no matter how green the suite is.
- **Trusting the response field as documentation.** `baseline_hours: 48` read like a description of behavior. It was actually a restatement of the same unverified assumption, so it corroborated nothing.
- **Runtime observation would not have helped either.** There is no assertion the tool could have failed. Correct-shaped output with a wrong denominator produces no error signal at any layer.

What *did* work: joining the per-call cap against the **real cardinality of the underlying store**. The decisive evidence was not in either file that contained the bug — it was the volume comment in `scripts/lib/story-track-batch-reader.mjs:10-18`, put there by an unrelated feature. Answering "how many rows are actually behind this key?" instead of "what does the retention constant say?" is what turned two defensible constants into one arithmetic contradiction.

## Solution

Split the recent and pre-window data into separately bounded cohorts. A single
newest-first range can be consumed entirely by recent traffic, so one pipeline
now carries two `ZRANGE` commands:

```ts
const zres = await redisPipeline([
  [
    'ZRANGE', DIGEST_ACCUMULATOR_KEY_MCP,
    String(nowMs), String(windowStart),
    'BYSCORE', 'REV', 'WITHSCORES', 'LIMIT', '0', String(KEYWORD_SPIKE_MAX_STORIES),
  ],
  [
    'ZRANGE', DIGEST_ACCUMULATOR_KEY_MCP,
    String(windowStart - 1), String(nowMs - KEYWORD_SPIKE_BASELINE_MS),
    'BYSCORE', 'REV', 'WITHSCORES', 'LIMIT', '0', String(KEYWORD_SPIKE_MAX_STORIES),
  ],
]);
```

Each cohort is capped at 800 stories. The recent cap therefore cannot consume
the baseline rows, while the worst-case request remains explicitly bounded at
1,600 story records.

If no pre-window rows exist, the tool does not claim a cold start. It returns
no spikes with an explicit note and does not cache the result:

```ts
if (baselineEntries.length === 0) {
  return {
    ...emptyResult,
    story_count: recentEntries.length,
    sample_truncated: sampleTruncated,
    note: 'baseline unavailable: no pre-window stories were present; spikes were not computed or cached',
  };
}
```

The denominator is the exact pre-window duration represented by the baseline
cohort. The shared core divides by the positive fractional number of recent
windows in that duration instead of flooring the divisor to one:

```js
if (!Number.isFinite(baselineDurationMs) || baselineDurationMs <= 0) return [];
const baselineWindows = baselineDurationMs / windowMs;
```

For example, one baseline mention observed over one hour with a two-hour recent
window normalizes to two mentions per window. Treating that hour as a full
window would halve the baseline and could manufacture a spike.

`baseline_hours` reports the pre-window duration, `story_count` covers both
bounded cohorts, and `sample_truncated` is a required output field that becomes
true when either cohort reaches 800 rows. The cache key advanced from `v1` to
`v2`, so payloads computed under the old sampling contract cannot survive the
deployment.

The same pass made downstream story reads all-or-nothing for caching. HMGET
and SMEMBERS pipeline replies must match their command count and carry the
expected per-command result shape. Short arrays, malformed results, and
command-level errors return the existing partial-read note and never write the
shared 10-minute cache.

Regression coverage now crosses every relevant boundary:

- 900 recent rows prove the recent cap engages while a second cohort still
  reaches pre-window history.
- A recent-only corpus proves missing baseline history emits no cold-start
  spikes and writes no cache.
- A one-hour baseline proves fractional normalization against a two-hour recent
  window.
- Short, malformed, and command-error replies are exercised for both HMGET and
  SMEMBERS.

## Why This Works

- **Recent load cannot erase baseline evidence.** The pre-window query has its
  own cap and score range.
- **No baseline is distinct from cold start.** The tool declines to classify or
  cache spikes when the comparison cohort is unavailable.
- **The denominator is measured.** The oldest sampled pre-window row determines
  the exact fractional duration used by the spike math.
- **Provenance is machine-readable.** `baseline_hours` and required
  `sample_truncated` describe what the two queries actually returned.
- **Partial dependency failures cannot become authoritative output.** Incomplete
  pipeline replies are explicitly degraded and excluded from caching.

## Prevention

**The class:** *a bounded fetch silently narrows the window a derived statistic claims to cover.* The cap lives at the query layer, the span constant lives at the math layer, each is defensible in isolation, and the mismatch surfaces only as quietly wrong numbers — no exception, no log line, no failing assertion.

**Detection heuristic — apply to any rate, baseline, per-hour, share, or percentage:**

1. **Name the numerator's source and the denominator's source separately.** If the numerator comes from a *fetch* and the denominator comes from a *constant*, you are looking at this bug until proven otherwise. The constant is a statement about the store; the fetch is a statement about the sample; only one of them describes the numbers in hand.
2. **Grep the path between the store and the statistic for a bound**: `LIMIT`, `LIMIT 0 N`, `.slice(`, `take`, `maxResults`, `page_size`, `count:`, `topK`. Any one of them means the sample is a subset, and the burden of proof is on the code to show the subset spans what the math assumes.
3. **Join the cap against the store's real cardinality, not its config constant.** Retention, TTL, and window constants describe policy; they say nothing about volume. Find the honest number — a row count, a `ZCARD`, a monitoring dashboard, or, as here, a volume comment left by a *different* feature that had to deal with the same store (`scripts/lib/story-track-batch-reader.mjs:10-18`). If the honest number times the assumed span exceeds the cap by an order of magnitude, the statistic is wrong.
4. **Check the sort direction — truncation is biased, not random.** `REV`/`DESC` + `LIMIT` keeps the *newest* rows, which is exactly the numerator's side of a recent-vs-baseline ratio: the cap eats the baseline first. `ASC` + `LIMIT` biases the opposite way and starves the recent window instead. Either way the survivors are not a sample of the whole.
5. **Treat every response field that restates a constant as an unproven claim.** If a tool reports `baseline_hours`, `coverage_days`, `sample_size`, or `window`, that value must be *computed from the rows returned*. A field echoing an input constant is documentation of an assumption, not of behavior — and for MCP tools it is worse than useless, because the model consuming it has no way to check.

**Test shape that catches it:**

Seed more recent rows than the recent cap and add a small pre-window cohort.
Assert that truncation is disclosed, the baseline cohort is still present, and
`baseline_hours` equals the pre-window duration rather than total elapsed time.
Then remove the pre-window cohort and assert empty spikes, an explicit note, and
no cache write.

Two corollaries worth generalizing:

- **If a code path has a cap, at least one test must exceed it.** The pre-existing fixtures here seeded 35 and 450 rows against an 800 cap; both were meaningful tests of other behavior and neither could ever have caught this. Sizing a fixture "big enough to look realistic" is not the same as sizing it to cross a specific boundary. Enumerate the caps, then make sure one fixture per cap sits on the far side of it.
- **Also pin the non-truncated case to the measured value.** A corpus whose
  oldest story is 32 hours old with a 2-hour recent window must report 30
  baseline hours, not 32 total hours or 48 hours of retention.

**Related shapes already in this repo's history** — same family, different surface, worth checking together when auditing:

- **Coverage-floor vs staleness conflation** in health/seed-meta checks: a record-count shortfall ORed into an age-based `stale` boolean, so minutes-fresh data reports stale forever while the published schema still describes `stale` as age-only. Same root move — one field carrying two independent claims.
- **Cache predicates that short-circuit on coarse-bucket equality** (`dateKey === today`, `hour === currentHour`) without an age check, silently disabling the refresh scheduler while the UI shows a monotonically growing "cached Nh ago" badge. Same root move — a proxy for freshness substituted for a measurement of it.

## Related Issues

- Issue [#5697](https://github.com/koala73/worldmonitor/issues/5697) — the parent feature (on-demand NLP MCP utilities) this tool was added for; PR [#5734](https://github.com/koala73/worldmonitor/pull/5734) carries both the tool and this fix.
- [`docs/solutions/best-practices/gate-rollouts-on-traffic-weighted-data-not-a-hand-picked-cohort.md`](../best-practices/gate-rollouts-on-traffic-weighted-data-not-a-hand-picked-cohort.md) — closest existing analogue: a derived statistic (p95) misled because its real sample differed from the assumed frame, fixed by reporting the actual sample size instead of trusting it. Different subsystem, same abstract move.
- [`docs/solutions/logic-errors/locale-specific-china-news-coverage-projection.md`](locale-specific-china-news-coverage-projection.md) — a published contract claimed coverage its computed inputs never verified. Same "advertised a frame it did not sample" shape.
- [`docs/solutions/logic-errors/bootstrap-key-health-missing-payload.md`](bootstrap-key-health-missing-payload.md) — adjacent freshness/coverage precedent: a green signal that disagreed with what was actually produced.
- [`docs/solutions/security-issues/mcp-quota-credential-class-vs-plan-family-scoping-bypass.md`](../security-issues/mcp-quota-credential-class-vs-plan-family-scoping-bypass.md) — another `api/mcp/*` correctness bug surfaced by the same multi-reviewer adversarial process, not by tests.
- Issue [#5723](https://github.com/koala73/worldmonitor/issues/5723) — `e2e/keyword-spike-flow.spec.ts` fails on `main` independently of this fix; noted here only so the two are not conflated.
