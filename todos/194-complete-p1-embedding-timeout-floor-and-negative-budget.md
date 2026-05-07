---
status: complete
priority: p1
issue_id: 194
tags: [code-review, digest-dedup, phase-a, correctness, performance]
dependencies: []
---

# Embedding `AbortSignal.timeout` floor + negative-budget fast-path

## Problem Statement

In `scripts/lib/brief-embedding.mjs:153` the batched embeddings call uses:

```js
signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
```

Two correctness concerns surfaced convergently by the perf + kieran-ts reviewers:

1. **Floor allows total wall-clock overshoot.** The orchestrator's `DIGEST_DEDUP_WALL_CLOCK_MS` contract says "hard cap at 45s or abort the whole batch". If `deadline - nowImpl()` returns 40ms (cache lookup was slow), the floor lengthens the fetch to 250ms — the cron tick silently runs 210ms past budget.
2. **Negative budget fast-pathed to a guaranteed timeout.** If cache lookup already exceeded the deadline, `timeoutMs` goes negative. `Math.max(250, negative)` → 250ms, so we open an HTTP connection to OpenRouter that is guaranteed to time out. Wastes a network round-trip and an OpenRouter quota slot on a request we already know is doomed.

Neither is a functional bug (all-or-nothing fallback still works), but both are incorrect by the "all-or-nothing" contract.

## Findings

- `brief-embedding.mjs:153` `Math.max(250, timeoutMs)` — discussed above.
- `brief-embedding.mjs:243` caller passes `timeoutMs: deadline - nowImpl()` without re-checking deadline. Line 242 throws on deadline-exceeded BEFORE cache lookup but not after, so the gap between cache lookup and API call is unchecked.

## Proposed Solutions

### Option 1 — pre-check and remove floor (recommended)
```js
if (timeoutMs <= 0) throw new EmbeddingTimeoutError();
signal: AbortSignal.timeout(timeoutMs),
```

**Pros:** correct by construction; skips pointless round-trip.
**Cons:** 250ms floor was defensive for tiny-positive values (e.g. 15ms) where a real OpenRouter RTT + TLS handshake wouldn't fit anyway. But the orchestrator can't do better than the math says.
**Effort:** Small
**Risk:** Low — every test still passes (scenario 2 throws synchronously via the stub).

### Option 2 — re-check deadline in orchestrator before embed call
In `brief-dedup.mjs:254-261`, bail to fallback before calling `embedImpl` when `nowImpl() >= deadline`.

**Pros:** symmetry with cache-lookup check.
**Cons:** pushes contract knowledge up one layer.
**Effort:** Small
**Risk:** Low

### Option 3 — keep the floor, log once on overshoot
Emit a `warn` when `timeoutMs < 250` so operators see it.

**Pros:** visibility.
**Cons:** doesn't fix the overshoot.
**Effort:** Small
**Risk:** Low

## Recommended Action
_Option 1 + Option 2 both; they're tiny._

## Technical Details
- `scripts/lib/brief-embedding.mjs:153` — the floor
- `scripts/lib/brief-embedding.mjs:240-242` — the call site's deadline math
- `scripts/lib/brief-dedup.mjs:247-254` — orchestrator embed call

## Acceptance Criteria
- [ ] Passing `wallClockMs: 10` through a stubbed slow cache (e.g. now() monotonic past deadline) throws `EmbeddingTimeoutError` without invoking `fetch`.
- [ ] Passing `wallClockMs: 100` with a stub cache that takes 150ms throws `EmbeddingTimeoutError`.
- [ ] All existing 64 dedup tests still green.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewers: performance-oracle, kieran-typescript-reviewer
