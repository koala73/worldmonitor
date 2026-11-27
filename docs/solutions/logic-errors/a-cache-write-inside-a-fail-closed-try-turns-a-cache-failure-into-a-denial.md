---
module: notification-relay
date: 2026-11-22
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "A paying user misses a real-time alert when one Upstash SET fails, with no entitlement outage"
  - "The relay logs `[relay][entitlement-fail-closed] error for <user>` although the entitlement read returned 200"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [fail-closed, cache-write, entitlement, model-checking, fault-injection, notification-relay]
---

# A cache write inside a fail-closed try turns a cache failure into a denial

## Problem

`getUserTier` in `scripts/notification-relay.cjs` reads a user's tier from Convex and fails closed: on any error it returns tier 0, so a paywalled alert is never sent to a free user during an outage (#3485). The success path wrote the tier to the Redis cache inside the same `try`. When that cache write failed, the error fell into the fail-closed `catch`. A Pro user was clamped to free tier and lost the alert. The `catch` also tried to cache tier 0 for 60 seconds.

## Symptoms

- One failed or lost Upstash request is enough. No entitlement outage is needed.
- The log line names an entitlement failure for a read that succeeded, so the log points at the wrong system.

## What Didn't Work

- Reading the code. The `try` looks like it guards the network read, and the cache write reads as bookkeeping. The write had been there since the entitlement check shipped (#2899).
- The relay's unit tests. None injected a failure into the success-path cache write.

## Solution

Every entitlement cache write goes through one helper that cannot throw (PR #11113):

```js
// Never throws: a failed cache write inside getUserTier's try would take the
// fail-closed path and clamp a paying user to free tier.
async function cacheUserTier(cacheKey, tier, ttlSeconds) {
  await upstashRest('SET', cacheKey, String(tier), 'EX', String(ttlSeconds)).catch(() => null);
}
```

All three writes in `getUserTier` call it. Before the fix, the success path was:

```js
const { tier } = await res.json();
await upstashRest('SET', cacheKey, String(tier ?? 0), 'EX', String(ENTITLEMENT_CACHE_TTL)); // throws into the fail-closed catch
return tier ?? 0;
```

## Why This Works

A fail-closed `catch` must only see errors from the decision it guards, which here is the entitlement read. A cache write is best effort. Its failure should cost one extra read later, never a denial now. Making the helper swallow its own error removes the path from cache failure to the fail-closed branch.

## How it was found

`tests/notification-relay-claim-model.test.mts` runs the real `processEvent` through `tests/helpers/interleavings.mjs`. Every Redis command and Convex request can fail before it runs or lose its response after. The model explores every placement of one fault and checks that each matched user is alerted exactly once. The failing trace was a lost response on `SET relay:entitlement:user-a`.

Three harness lessons came out of building it:

- **Reset module-global state between runs.** The relay keeps in-process fail-open reservations. Without clearing them, one run's reservation suppressed the next run's alert, and the model reported a false bug. `resetRelayProcess` in the test clears them, plus the blocked-link cache.
- **Make random values deterministic.** Claim tokens come from `randomUUID`. The explorer replays a choice prefix and checks the same commands repeat, so the test stubs `randomUUID` to `token-N`.
- **Prove the check fails where CI runs it.** `node scripts/check-model-mutations.mjs relay-claims` reverts this fix and two #10222 fixes in the real relay and confirms the model catches each one. (auto memory [claude]: a revert proof in a bare worktree once passed in CI because installed dependencies changed what the check saw, so run it after bootstrap.)

## Prevention

- Keep best-effort writes out of a fail-closed `try`, or route them through a helper that cannot throw.
- When a function fails closed, list every awaited call inside its `try`. Each one is a way to deny.
- Rerun the relay model after changing `getUserTier`, `cacheUserTier` or the claim path. The `verify-relay-claims` skill in `.agents/skills/` lists the covered functions.

## Related

- #10222: release the dedup claim and re-queue when the channel read fails (SM-115). The same model replays that bug.
- #3485: why the entitlement read fails closed.
