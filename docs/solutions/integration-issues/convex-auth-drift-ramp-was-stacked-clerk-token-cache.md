---
title: The May–July Convex auth-drift ramp was the stacked Clerk token cache, not a cut-window deploy
module: Convex / Clerk auth
date: 2026-08-23
category: integration-issues
problem_type: integration_issue
component: authentication
severity: high
symptoms:
  - "WORLDMONITOR-QK (convex_auth_drift) ramped 13.6x from 8 to 109 events/week across 344 users, then decayed without a diagnosed cause"
  - "Every tagged event is production POST userPreferences:setPreferences — zero GET events"
  - "The last high-rate event (2026-07-28T22:40Z) sits after the real fix merged, so a merge-window search that starts there misses it"
root_cause: async_timing
resolution_type: documentation_update
related_components:
  - testing_framework
  - documentation
tags:
  - sentry
  - clerk
  - convex
  - jwt
  - token-cache
  - auth-drift
  - two-verifier
---

# The May–July Convex auth-drift ramp was the stacked Clerk token cache, not a cut-window deploy

## Problem

`WORLDMONITOR-QK` (`convex_auth_drift`) records the case where `/api/user-prefs` accepted a Clerk bearer via `validateBearerToken` and Convex still rejected it with `{"code":"Unauthenticated","message":"Could not verify OIDC token claim…"}`. From late May through late July 2026 that bucket grew from 8 to 109 events/week (13.6x) across 344 distinct users, max 3 events per user, then dropped back to the ~5 events/week baseline. The issue sat on `archived_forever`, so the ramp never reopened it. The decay was visible only in hindsight.

The first diagnosis bounded the cut to `[2026-07-28T22:40Z, 2026-07-29T23:05Z]` — last high-rate event to first post-decay event — and therefore excluded the actual fix. The five PRs inside that window (#5798, #5791, #5786, #5812, #5816) do not touch Clerk→Convex token minting. #5832 (clock tolerance) merged *after* the decay had already started.

## Root cause

Two caches were stacked, and the outer one assumed every token arrived freshly minted.

1. Clerk's `session.getToken()` is stale-while-revalidate: inside 15 seconds of `exp` it returns the cached token immediately and refreshes in the background.
2. `getClerkToken()` then stamped whatever it received with a flat 50 s TTL, on the premise written into its own comment: "Clerk tokens expire at 60s."

A refresh that landed inside Clerk's stale window therefore cached a token with ≤15 s of life and kept serving it for the full 50 s. That one defect has two faces, depending on whether the token had expired yet when the request hit the edge:

| Token age when the request is signed | Edge `jwtVerify` | Convex OIDC check | Sentry bucket |
|---|---|---|---|
| Already past `exp` | 401 — never reaches Convex | — | Edge identity loss (WORLDMONITOR-XR / XQ) |
| Still inside `exp`, but only a few seconds left | Accepts | Rejects after RTT / clock gap | **QK** (`convex_auth_drift`) |

QK is the near-expiry face. That is why every one of the 355 tagged events is `POST userPreferences:setPreferences`: prefs **writes** happen after the token has been sitting in the client cache; the sign-in **GET** uses a just-fetched token and almost never loses the race. It is also why each user appears once or twice and a retry recovers — the next `getToken()` eventually returns a fresh JWT.

The IPs on those events are AWS ranges in Vercel regions (Mumbai, Singapore, Sydney, Cape Town, Frankfurt, São Paulo). That is edge egress, not a user-geography shift. Distant regions make the two-verifier race easier to lose, but they do not explain the ramp or the cut.

### Why the cut window missed the fix

[#5753](https://github.com/koala73/worldmonitor/pull/5753) (`fix(auth): bound Clerk token cache by the token's own expiry`) merged at **2026-07-28T17:57:16Z**. Reuse is now bounded by both the flat TTL *and* `exp` minus a 10 s safety margin, and a near-expiry Clerk leftover forces `skipCache: true`.

The last high-rate QK event is **2026-07-28T22:40:48Z** — 4 h 43 m later. That tail is stale browser bundles still running the old cache. A cut window that starts at the last high-rate event therefore starts *after* the fix and looks at the wrong five PRs.

#5832 (five-second edge `clockTolerance`, merged 2026-07-30T06:02:48Z) is a different seam: it lets the edge accept a token that is already slightly past `exp`, then skips the QK capture when Convex rejects it as expected near-expiry. It cannot be the decay. Later follow-ups (#5933 keep-on-refresh-fail, #5937 session-switch, #5938 client clock skew) tighten the same cache; they are not required to explain the July 28 drop.

## What remains

Residual QK volume (~5 events/week, one event per user) is the designed two-verifier baseline: a token that still clears the 10 s client margin can age past Convex's leeway during the edge→Convex round trip, especially from distant Vercel regions. `api/user-prefs.ts` skips the drift capture when `acceptedWithinClockTolerance` is set so that leftover does not drown the bucket.

No live product defect remains from the May–July ramp. Re-introducing a TTL-only Clerk cache would revive both XR/XQ and QK.

## Prevention

- When a Sentry rate *decays*, do not start the causal window at the last high-rate event. Look for the merge that removed the feeder, then treat post-merge high-rate events as stale-client tail.
- A two-verifier 401 (edge accept, upstream reject) on a near-expiry JWT is usually a client cache serving a leftover, not JWKS/audience/issuer drift. Diff the token cache before the auth config.
- Bound token reuse by the token's own `exp` (minus flight/skew margin), not only by a flat TTL that assumes every `getToken()` returns a newly minted JWT.
- `archived_forever` opts out of Sentry escalation. A `warning`-level capture whose only alarm is "volume will reopen the issue" is mute unless `substatus` is `archived_until_escalating`. That archive-mode trap is the subject of #7093 / #7094; it is why this ramp was silent, not why it happened.

## Files

- `src/services/clerk.ts` — `shouldReuseCachedClerkToken`, `TOKEN_EXPIRY_SAFETY_MARGIN_MS`, forced `skipCache` refresh
- `tests/clerk-token-cache-expiry.test.mts` — the near-expiry stale-while-revalidate case and the 10 s margin
- `api/user-prefs.ts` — QK capture; skip when `acceptedWithinClockTolerance`
- `server/auth-session.ts` — edge `jwtVerify` + bounded `clockTolerance`
- `convex/auth.config.ts` — Convex accepts `aud: "convex"` only

## Related

- #7092 — this diagnosis
- #5753 — the cache-expiry bound that cut the ramp
- #5752 / #5832 — edge clock tolerance (after the decay)
- #7093 / #7094 — why QK could not reopen while `archived_forever`
- WORLDMONITOR-XR / XQ — expired-token face of the same stacked cache
