---
title: "Checkout Rate-Limit Operations"
description: "Operational contract for the terminal CHECKOUT_RATE_LIMITED rate alarm: thresholds, owner, triage, and Dodo's published per-key rate limit."
---

# Checkout Rate-Limit Operations

Issue [#6027](https://github.com/koala73/worldmonitor/issues/6027) stopped Dodo
`429`s from hard-blocking checkout by absorbing them in a bounded server-side
retry ladder. This page owns the **tail** of that ladder: the checkouts where
the ladder ran, was exhausted, and Dodo was still limiting our shared API key,
so the buyer got a terminal `429 CHECKOUT_RATE_LIMITED` and a "please retry"
toast. Nothing watched that rate before [#6698](https://github.com/koala73/worldmonitor/issues/6698).

## What the alarm measures

- **Signal source is the server, not the browser.** Every terminal 429 writes
  one row to `checkoutRateLimitEvents` from
  `convex/payments/checkout.ts`. Both entry points funnel through that function
  (`createCheckout` for the dashboard, `internalCreateCheckout` for the
  `/relay/create-checkout` edge gateway), so no occurrence can be missed by an
  ad blocker, client sampling, or a Sentry project inbound filter.
- **Only exhausted ladders count.** A 429 the ladder absorbed and retried into
  a successful checkout writes nothing. The alarm measures buyers who were
  turned away, not provider turbulence they never saw.
- **The browser Sentry issue stays as corroboration.** `WORLDMONITOR-Y1`
  (`Checkout error: rate_limited`) is level `info` and pages nobody by design.
  Keep it `unresolved` — resolving it discards the only pre-alarm history of
  this failure.

## Thresholds and owner

| Field | Value |
| --- | --- |
| Burst window | 24h rolling, fires at **5** terminal 429s |
| Drift window | 7d rolling, fires at **12** terminal 429s |
| Cooldown between signals | 6h |
| Row retention | 8d (drift window plus one day of margin) |
| Channel | `console.error` from Convex, forwarded to Sentry by Convex auto-Sentry as an error-level event |
| Message prefix | `[checkout-rate-limit-alarm]` |
| Owner | `@koala73` — reassign here and in the Sentry issue owner if payments ownership moves |

Constants live in `convex/payments/checkoutRateLimitAlarm.ts`. Change them
there and in the table above together.

### How the thresholds were sized

Sized against the observed floor, not against a test fixture: **7 terminal
429s between 2026-08-01 and 2026-08-13** is about 0.54/day and 3.8/week.
Treating arrivals as Poisson at that rate:

| Threshold | False alarm rate at today's floor |
| --- | --- |
| 5 in 24h | about one per 11 years |
| 12 in 7d | about one per 35 years |

Sensitivity to a sustained rise, same model:

| Rate vs. today | Days for the 24h alarm to fire | Weeks for the 7d alarm to fire |
| --- | --- | --- |
| 2x | 201 | 12 |
| 3x | 41 | 2 |
| 5x | 7 | 1 |
| 10x | 2 | 1 |

Read that as designed: the 7d window is the drift detector and the 24h window
is the burst detector. A launch or campaign spike pages within a day or two. A
slow 2x drift takes about three months to reach the drift threshold — if that
is too slow once real growth data exists, lower the 7d threshold to 10 first
(about one false alarm per 3.5 years) rather than touching the 24h one.

### The alarm's own failure mode

If the recording mutation fails, the checkout still returns its normal typed
429 to the buyer — a degraded alarm must never turn a retryable rate limit
into a hard checkout failure. But the failure is not swallowed: it emits its
own `[checkout-rate-limit-alarm] ... the rate alarm is blind` error. Treat that
message as "the alarm is down", not as noise.

## When it fires

1. **Confirm the shape.** The Sentry message carries `day=N/5`, `week=N/12`,
   which windows breached, and the most recent buyer and product. A day breach
   with a normal week count is a burst; a week breach alone is drift.
2. **Check whether it is us.** The limit is keyed to the API key, and checkout
   is not the only caller holding `DODO_API_KEY` — see the next section. Look
   for a `product-catalog` cache miss or a Railway price-poll in the same
   minute before assuming buyer contention.
3. **Size the damage.** Each row is one paying-intent click that ended in a
   manual retry. Query `checkoutRateLimitEvents` for the affected `userId`s;
   the buyer is not stranded (the client renders a wait-and-retry toast and
   gates re-clicks during the cooldown), but the conversion is at risk.
4. **If it is sustained, raise the ceiling.** Dodo tiers are below; upgrading
   is a support request, not a code change.
5. **Only then consider client-side auto-retry.** #6698 deliberately ranks this
   last: it adds pressure to the same shared bucket and is unjustified until
   the alarm shows real growth.

## Dodo's published rate limits

From the [Dodo Payments API reference](https://docs.dodopayments.com/api-reference/introduction),
read 2026-08-14. These are the real numbers #6027's ladder constants can be
sized against.

| Tier | Burst (per second) | Sustained (per minute) |
| --- | --- | --- |
| Tier 0 (default) | 40 | 240 |
| Tier 1 | 100 | 1,000 |
| Tier 2 | 500 | 5,000 |

- **Keyed on the authentication method and business tier** — one bucket for
  every caller holding `DODO_API_KEY`, which is what makes a client-side retry
  useless here. Unauthenticated requests are limited separately by IP
  (20/s, 100/min).
- **Raisable: yes.** "Contact support to upgrade your business to a higher rate
  limit tier." We have not requested an upgrade, and we have not confirmed
  which tier the account is actually on — assume Tier 0 until support says
  otherwise.
- **Advertised headers on a limited response:** `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### What those numbers imply

240 requests/minute sustained is far above WorldMonitor's checkout volume, so
the terminal 429s are almost certainly **burst** collisions against the 40/s
ceiling rather than sustained exhaustion. Checkout traffic alone cannot
plausibly produce a 40-request second at current volume, which points at the
other holders of the same key:

- `api/product-catalog.js` fetches all **9** catalog products concurrently on a
  Redis cache miss (1h TTL). One miss is a 9-request burst; several edge
  regions missing in the same second multiply it.
- `convex/payments/billing.ts` (portal sessions, the 6-hourly stuck-payment
  reconciliation) and the Railway price poll in `scripts/ais-relay.cjs` share
  the key too.

That is arithmetic plus a hypothesis, not a measured cause. The alarm exists to
supply the correlation data needed to confirm or kill it.

### The ladder's provider floor

`retryAfterMsFromError` in `convex/payments/checkoutRateLimit.ts` reads three
headers, strongest signal first:

| Header | Meaning | Unit |
| --- | --- | --- |
| `retry-after-ms` | Explicit wait | Milliseconds |
| `retry-after` | Explicit wait (RFC 9110) | Delta-seconds **or** an HTTP-date |
| `x-ratelimit-reset` | When the window rolls over | Inferred — see below |

`Retry-After` wins over `X-RateLimit-Reset` deliberately: the first is a
directive to wait, the second only reports when the window resets.

A numeric `Retry-After` is always read as delta-seconds and never retried as a
date — a negative value is rejected outright rather than falling through to the
date branch, where V8 would read `-5` as May 2001 and clamp it to "wait zero".
No real HTTP-date is lost to this: all three RFC 9110 date forms begin with a
day name.

Originally the ladder read only the two `Retry-After` forms. Dodo's API
reference documents neither on a 429 — it documents `X-RateLimit-Reset` — so if
Dodo does not also send `Retry-After`, the "honor the advertised provider floor"
branch never engaged and every wait was pure jitter. The ladder now reads
`X-RateLimit-Reset` as well.

**Its unit is inferred by magnitude, because Dodo does not publish one.** The
header is genuinely ambiguous across the industry: the IETF draft's
`RateLimit-Reset` is delta-seconds, while this repo's own API emits
`X-RateLimit-Reset` as epoch-milliseconds (`server/_shared/api-key-rate-limit.ts`).
All three encodings are accepted:

- below `1e9` — delta-seconds (a delta that large would be ~31 years)
- `1e9` to `1e12` — epoch-seconds (an epoch in seconds passed `1e9` in 2001)
- `1e12` and above — epoch-milliseconds

A reset already in the past clamps to `0`, so it can never subtract from the
jittered wait. Each encoding is pinned by a test, and the sweep confirms an
epoch misread as a delta is caught — that defect would produce a decades-long
floor and silently disable every retry.

**Two things are still unmeasured, and the alarm is what will settle them:**

1. Which encoding Dodo actually sends. The magnitude rules cover all three, so
   this is safe rather than settled.
2. Whether the reset describes the **burst** (40/s) or the **sustained**
   (240/min) window. This matters: if Dodo reports a sustained reset up to 60s
   out while the real block is a per-second burst that clears immediately,
   honoring it as a hard floor ends the ladder early and turns a checkout the
   ladder would have rescued into a terminal 429. Watch for the alarm rate
   rising after this change ships — that is the signature, and the fix would be
   to cap the reset-derived floor rather than to stop reading the header.

## Related

- `convex/payments/checkoutRateLimitAlarm.ts` — thresholds, classifier, recorder
- `convex/payments/checkoutRateLimit.ts` — #6027's bounded retry ladder
- `src/services/checkout-errors.ts` — the buyer-facing `rate_limited` mapping
- `tests/checkout-rate-limit-alarm.test.mts`,
  `convex/__tests__/checkoutRateLimit.test.ts` — threshold and end-to-end coverage
