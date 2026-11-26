---
name: verify-relay-claims
description: Model-check that the notification relay alerts every matched user once when a Redis or Convex request fails. Use when changing processEvent, the dedup claim, releaseRealtimeClaim, releaseDedupClaim, the re-queue after a failed read, or getUserTier and cacheUserTier in scripts/notification-relay.cjs, or recordDedupOutcome in scripts/shared/notification-dedup.cjs.
metadata:
  internal: true
---

# Verify relay claims

**Property.** When one Redis or Convex request fails or loses its response, every user whose rule matches a critical real-time event gets the alert exactly once.

**Harm.** A missed alert is silent. Before #10222, a failed channel read left the user's dedup claim in place, so the alert was suppressed on every channel for 30 minutes (SM-115).

For each matched user, the relay:

1. Claims `wm:notif:dedup:<user>:<hash>` with `SET NX` and a per-claim token.
2. Reads the user's tier and channels from Convex.
3. Sends.

When the channel read fails, it releases its own claim with compare-and-delete and re-queues the event.

## Run

```bash
node --import tsx --test tests/notification-relay-claim-model.test.mts
```

It takes under a second and runs in CI with the other data tests. It checks three things:

- With no failures, each of two users is alerted once.
- With one failed or lost request anywhere, each user is still alerted once.
- With a failed or lost dedup claim and a failed channel read, every user is still alerted. A critical alert is sent when its claim errors, so this check allows a second alert.

## How it works

The model runs the real `processEvent` through `tests/helpers/interleavings.mjs`. It serves Upstash from the model Redis and Convex from fixed answers. Telegram sends are recorded and never fail. One relay processes the event and then each re-queued copy.

There is one actor, so the explorer varies where faults land, not the order of steps. Each Redis command and each Convex request can fail before it runs or lose its response after.

Each run starts a fresh relay. Setup resets the claim-token counter, the blocked-link cache and the in-process fail-open reservations. Without this, a reservation from one run suppresses an alert in the next, and the model reports a false bug.

## Reading a failure

A failure prints the users who were not alerted once, and the requests in order, for example:

```
sends per user user-a: 1, user-b: 0
  relay: SET wm:notif:dedup:user-a:...
  relay: SET wm:notif:dedup:user-b:...
  relay: POST /relay/channels user-b (request failed, nothing applied)
```

"the relay made requests the model does not serve" means `processEvent` called a new endpoint. Add it to the fake `fetch` in the test, with a fault point when its failure can cost an alert.

## Proving the model can fail

```bash
node scripts/check-model-mutations.mjs relay-claims
```

It applies three breaks to the real relay one at a time, runs the model, and restores the file:

- A failed channel read keeps the dedup claim. This is SM-115, fixed by #10222.
- The fail-open release skips the Redis claim that a lost `SET NX` response committed. The second commit of #10222 fixed this.
- A failed entitlement cache write clamps a paying user to free tier. This model found it.

Each must be caught. Run against the relay from before #10222 (`59f877b0b9^`), the model fails with the SM-115 trace. Against that PR's first commit (`ff1db23031`), the third check fails with a lost claim response followed by a failed channel read.

## Scope

Covered:

- One critical `rss_alert` matching two real-time Telegram rules.
- Up to `CHANNELS_FETCH_RETRY_MAX` re-queues.
- One fault anywhere, and two faults on dedup claims and channel reads.

Not covered:

- A failed entitlement read. It drops that user's alert on purpose, because the paywall fails closed (#3485).
- Two faults elsewhere. A failed channel read followed by a failed re-queue `LPUSH`, or a failed release, can lose the alert. The relay logs both.
- Two relays processing the same event.
- Quiet hours, digests, other channels and send failures. A failed send keeps its claim, so delivery is at most once.

## Coverage record

| Check | Code |
|---|---|
| relay actor | `processEvent`, `checkDedup`, `releaseRealtimeClaim`, `releaseDedupClaim`, `requeueAfterChannelsFailure`, `getUserTier`, `cacheUserTier` in `scripts/notification-relay.cjs`; `recordDedupOutcome`, `releaseFailOpenFallback` in `scripts/shared/notification-dedup.cjs` |

**Last confirmed against:** `be41291bb5`, plus the commits of the PR that adds this skill.

When any covered function changes, reread it against the model, rerun the check, and move this line forward only after both pass.
