---
title: The May–July Convex auth-drift ramp was the stacked Clerk token cache times a growing write path
module: Convex / Clerk auth
date: 2026-08-23
category: integration-issues
problem_type: integration_issue
component: authentication
severity: high
symptoms:
  - "WORLDMONITOR-QK (convex_auth_drift) ramped 13.6x from 8 to 109 events/week across 344 users, then decayed without a diagnosed cause"
  - "Every retained event is production POST userPreferences:setPreferences — 354 of 354, zero GET"
  - "The last high-rate event (2026-07-28T22:40Z) sits after the real fixes merged, so a merge-window search that starts there misses them"
  - "A constant client defect whose event volume climbs because the write path it rides keeps growing"
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

# The May–July Convex auth-drift ramp was the stacked Clerk token cache times a growing write path

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

QK is the near-expiry face. That is why the `method` tag reads `POST` on **354 of 354** retained events, every one of them `userPreferences:setPreferences`: prefs **writes** happen after the token has been sitting in the client cache; the sign-in **GET** uses a just-fetched token and almost never loses the race. It is also why each user appears once or twice and a retry recovers — the next `getToken()` eventually returns a fresh JWT.

The IPs on those events are AWS ranges in Vercel regions (Mumbai, Singapore, Sydney, Cape Town, Frankfurt, São Paulo). That is edge egress, not a user-geography shift. Distant regions make the two-verifier race easier to lose, but they are a constant, so they cannot by themselves produce a 13.6x climb — see *Why it ramped* below.

### Counting the population

Three different totals circulate for this issue, and they are all correct at what they measure:

| Figure | What it is |
|---|---|
| 364 / 344 users | Sentry's lifetime `count` / `userCount` as of 2026-08-25 — still accruing at the residual rate |
| 362 | The same lifetime count when #7092 was written on 2026-08-22 |
| 354 | Events still inside Sentry's ~90-day retention, and therefore the only ones whose tags can be read |

The 10-event gap between lifetime and retained is aged-out data, not a GET/POST split. "Zero GET events" is a claim about the **retained** 354; the events that aged out cannot be re-checked.

## Why it ramped

The stacked cache explains *why any given POST failed*. It cannot on its own explain why the rate grew 13.6x, because it was not new: `TOKEN_CACHE_TTL_MS` shipped with the original Clerk integration in [#1812](https://github.com/koala73/worldmonitor/pull/1812) on 2026-03-26, two months before the first ramp bucket. A defect that constant produces a constant *rate per POST*, not a climbing weekly count.

What climbed was the number of POSTs. QK volume is the product of two terms — the per-write failure probability (constant) and the write volume (not constant) — so the ramp is an **exposure** curve, and the exposure grew every time another piece of state started riding the cloud-prefs write path:

| Merged | PR | What it added to the write path |
|---|---|---|
| 2026-06-16 | [#4323](https://github.com/koala73/worldmonitor/pull/4323) | Dashboard tabs — each tab persists its own panel selection and order |
| 2026-07-04 | [#4741](https://github.com/koala73/worldmonitor/pull/4741) | Per-Clerk-user dirty markers for monitor edits, plus a refresh on cloud-applied change |
| 2026-07-06 | [#4926](https://github.com/koala73/worldmonitor/pull/4926) | `wm-read-state-v1` added to `CLOUD_SYNC_KEYS` — a visit timestamp flushed on every hide/unload |

Set against the weekly series (17 on 2026-06-08, 26 on 06-15, 52 on 07-06, 109 on 07-20), all three land in or just before the weeks that step up, and #4926 in particular precedes the steepest climb to the peak. Be careful how much that is asked to carry: the series in #7092 is abridged, weekly buckets are coarse next to merge timestamps, and no per-week write-volume metric was retained to measure exposure directly. What is solid is the mechanism and the direction — the write path demonstrably grew three times across the ramp, and QK volume is proportional to it. Attributing a particular week's count to a particular PR is not supported.

The apparent counter-example does not hold. [#4588](https://github.com/koala73/worldmonitor/pull/4588) and [#4639](https://github.com/koala73/worldmonitor/pull/4639) (2026-07-01/02) added a per-user write budget, and the ramp went on to peak on 2026-07-20 regardless — but that budget is **30 writes/minute**, a ceiling sized to stop a runaway client, not to shape ordinary sync traffic. It never bound the population producing QK.

### What the onset cannot tell us

The ramp's own starting point is **not** recoverable. Sentry's `firstSeen` for QK is `2026-05-08T14:12:36Z`, but the oldest event still inside retention is `2026-05-28T01:33:14Z` — the 2026-05-25 bucket and everything before it has aged out, so no tag, release, or IP on those events can be read again.

Two things follow. First, that 8-events-per-week starting line is a **post-instrumentation** baseline, not the defect's beginning: the capture that creates this bucket landed in [#3601](https://github.com/koala73/worldmonitor/pull/3601) on 2026-05-05, three days before `firstSeen`, while the stacked cache had already been running since March. The bucket starts when we started looking. Second, whether anything *else* moved in the two weeks before 2026-05-25 is now unfalsifiable from retained data; the exposure mechanism above is established from 2026-06-16 onward, and the onset is inferred from it rather than independently confirmed.

### Why the cut window missed the fix

**Two** PRs merged on 2026-07-28, and each cuts one of the ramp's two terms:

- [#5755](https://github.com/koala73/worldmonitor/pull/5755) (`fix(prefs): serialize cloud preference writes`) at **10:32:18Z** put every writer — sign-in reconciliation, debounced uploads, sign-out keepalives, hidden-tab flushes — behind one FIFO queue, coalesced duplicate uploads, and bounded Clerk token acquisition to 15 s. That cuts the **exposure** term the section above describes.
- [#5753](https://github.com/koala73/worldmonitor/pull/5753) (`fix(auth): bound Clerk token cache by the token's own expiry`) at **17:57:16Z** bounded reuse by both the flat TTL *and* `exp` minus a 10 s safety margin, forcing `skipCache: true` on a near-expiry Clerk leftover. That cuts the **per-write failure probability**.

Crediting the drop to #5753 alone overstates what one of the two did. Both landed inside the same working day and the event series has no resolution to separate them; what the mechanism does say is that either one alone would have bent the curve, and the residual behaviour since is consistent with both being in place.

The last high-rate QK event is **2026-07-28T22:40:48Z** — 4 h 43 m after #5753. A cut window that starts at the last high-rate event therefore starts *after* both fixes and looks at the wrong five PRs.

The tail is a stale **client bundle**, and the release tags prove the deploy was not at fault. The 22:40:48Z event carries `release: be51d2faf8d6`, a commit dated `2026-07-28T22:15:56Z` — 4 h 18 m *after* #5753 merged. The Vercel deployment serving that request already contained both fixes. Since `release` on a `(vc/edge/function` event names the deployment rather than the bundle sitting in the visitor's tab, and the deployment was demonstrably current, the only remaining place the old cache could have been running is a browser that had not reloaded. Both fixes live in `src/services/clerk.ts` and `src/utils/cloud-prefs-sync.ts`, so an open tab keeps the pre-fix behaviour until it does.

One thing the stale-bundle account does *not* explain is the shape of the stop. A bundle rollout predicts a decaying trickle; the data shows nothing at all between 22:40:48Z and `2026-07-29T23:05:18Z`, a full day. At a residual of roughly five events a week a one-day gap is unremarkable on its own, so this is weak evidence either way — but do not read the clean edge as extra confirmation.

#5832 (five-second edge `clockTolerance`, merged 2026-07-30T06:02:48Z) is a different seam: it lets the edge accept a token that is already slightly past `exp`, then skips the QK capture when Convex rejects it as expected near-expiry. It cannot be the decay. Later follow-ups (#5933 keep-on-refresh-fail, #5937 session-switch, #5938 client clock skew) tighten the same cache; they are not required to explain the July 28 drop.

## What remains

Residual QK volume (~5 events/week, one event per user) is the designed two-verifier baseline: a token that still clears the 10 s client margin can age past Convex's leeway during the edge→Convex round trip, especially from distant Vercel regions. `api/user-prefs.ts` skips the drift capture when `acceptedWithinClockTolerance` is set so that leftover does not drown the bucket.

No live product defect remains from the May–July ramp. Two things would bring it back, and they are independent. Re-introducing a TTL-only Clerk cache revives the failure rate, and with it both XR/XQ and QK. Separately, adding more state to `CLOUD_SYNC_KEYS` or otherwise raising `POST /api/user-prefs` volume raises QK proportionally *without any regression in the auth code* — a rising QK is therefore as likely to be a new sync key as a broken token cache, and the write path is the first place to look.

## Prevention

- When a Sentry rate *decays*, do not start the causal window at the last high-rate event. Look for the merge that removed the feeder, then treat post-merge high-rate events as stale-client tail. Check the tail events' `release` tag against the fix's deploy time — that separates "the fix had not shipped yet" from "the client had not reloaded yet".
- A ramping bucket does not imply a changing defect. Event volume is *failure rate x exposure*, so a constant bug climbs whenever the path carrying it gets busier. Before hunting for what broke, check what got **added** to that path — here, three PRs putting more state on the cloud-prefs write path account for the whole 13.6x.
- A `firstSeen` is when the capture shipped, not when the defect started. Compare it against the PR that introduced the capture before treating the earliest bucket as a baseline.
- Sentry retention (~90 days here) silently truncates exactly the early buckets an onset question needs. Establish the oldest *retained* event before building an argument on event-level data, and say so when the answer is out of reach.
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
- #5753 — the cache-expiry bound; cut the per-write failure rate
- #5755 — write serialization, merged the same day; cut the exposure
- #4323 / #4741 / #4926 — the write-path growth that produced the ramp
- #3601 — the capture that created this bucket, three days before `firstSeen`
- #5752 / #5832 — edge clock tolerance (after the decay)
- #7093 / #7094 — why QK could not reopen while `archived_forever`
- WORLDMONITOR-XR / XQ — expired-token face of the same stacked cache
