---
title: A timeout that assumed a provider-routing pin the seeder never had
date: 2026-07-14
category: integration-issues
module: seed-forecasts
problem_type: integration_issue
component: background_job
symptoms:
  - "market_implications wrote errorReason 'llm_no_response' on every hourly run"
  - "/api/health stuck at SEED_ERROR while the panel served frozen last-good cards"
  - "The LLM provider answers a trivial prompt instantly, so the model looks healthy"
root_cause: config_error
resolution_type: config_change
severity: high
related_components: [service_object, documentation]
tags: [llm, openrouter, deepseek, timeouts, provider-routing, seeders, security-policy]
---

# A timeout that assumed a provider-routing pin the seeder never had

## Problem

`market_implications` wrote `status: 'error' / errorReason: 'llm_no_response'`
on **every hourly run**. `/api/health` sat at `SEED_ERROR` indefinitely while the
homepage panel served **frozen last-good cards** — the failure path
EXPIRE-refreshes the canonical key, so the data never expired, it just never
updated.

The model was not slow, and the provider was not down.

## Root cause: a policy split across an import boundary

```js
// scripts/_llm-model-timeouts.mjs — before
export const DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS = 15_000;
// "Keep it above the pinned endpoint's observed p50"   <-- nothing pinned it
```

The comment names the assumption. **Nothing implemented it.** OpenRouter
free-routes `deepseek/deepseek-v4-flash` across backends whose latency spans an
order of magnitude. Measured against production on the real call shape
(`max_tokens: 2500`, ~2.3k-token prompt):

| backend | latency |
|---|---|
| AtlasCloud / Venice | 10–25s |
| DigitalOcean / GMICloud | 61–73s |
| NextBit | 110s |
| one call | >120s, never returned |

**The fastest of 12 unrouted samples was 17.1s — above the 15s clamp.** The
primary provider could not succeed *even once*: **0/12**. Not flaky. Impossible.

The routing *did* exist — in `server/_shared/llm.ts`. The Railway seeder cannot
import from `server/` (it packages only `scripts/`), so it inherited the
**timeout** but not the **routing**. That split is the bug.

The Groq fallback was simultaneously useless: its free tier caps at 100k
tokens/day and this stage alone needs ~114k (4,749 tokens × 24 hourly runs), so
it returned `429` in 86ms. Both providers empty → `llm_no_response`, every run.

## Solution (PR #5304, open as of this writing)

Move the routing policy next to the timeout it is inseparable from, in
`scripts/_llm-model-timeouts.mjs`, and have **both** consumers import it — so a
consumer cannot pick up one without the other.

```js
export const OPENROUTER_PROVIDER_ROUTING = {
  ignore: OPENROUTER_BLOCKED_PROVIDERS,   // China-hosted providers
  sort: 'throughput',                     // fastest eligible backend
};
```

Measured under that routing: **p50 15.3s, p90 22.4s, max 25.0s, 14/14** → a 40s
completion deadline covers 100%.

## The trap: the security policy and the latency fix pull in opposite directions

WorldMonitor blocks China-hosted inference providers because it is a
geopolitical product — an adapter could log queries or bias outputs on exactly
the topics it covers (Taiwan, Xinjiang, the South China Sea).

**Applying `sort: 'throughput'` *without* the blocklist routes those prompts
straight onto the blocked providers — precisely BECAUSE they are the fastest.**
The optimization actively selects for the thing the policy forbids. This nearly
shipped: the first draft added throughput-sorting alone, and its excellent
latency numbers were partly *achieved by* violating the policy.

They must ship together, and it is now pinned by a test.

Reassuringly, **blocking costs nothing** — the eligible set is *faster*
(p50 15.3s / max 25.0s) than the unrestricted set (p50 17.5s / max 34.7s). When
a security control looks like it has a performance price, measure it; the price
may be imaginary.

> Caveat recorded in-code: `novita` is on the blocklist but is
> San-Francisco-headquartered, and its GPU hosting is not publicly disclosed.
> The list is flagged for periodic re-audit. Loosening a security control should
> be its own reviewed change, never a rider on a latency fix.

## Two regressions the existing tests caught

Both would have shipped without the suite:

- **Raising the shared provider timeout to suit Flash loosened a different
  model.** `critical_signals` pins `google/gemini-2.5-flash` at 25s on the *same*
  provider entry. Fixed by giving Flash its own requested window and leaving
  other models on `provider.timeout`.
- **Replace-instead-of-min broke a shorter caller.** The shared server client
  passes 8s for some utility calls and must still get 8s. `Math.min(requested,
  cap)` had to stay; the long-generation caller opts into a bigger *cap*.

## One test started passing vacuously

Once Groq left the `market_implications` default chain, #4978's
stranded-fallback test began skipping **for the wrong reason** — it would have
kept passing while covering nothing. It now pins the two-provider chain
explicitly, because the fallback machinery must stay correct for any deployment
that configures one.

**Watch for this whenever you change a default:** a test that exercised a path
through the default silently stops exercising it, and green tells you nothing.

## Prevention

- **A comment asserting an invariant is not an invariant.** "Keep it above the
  pinned endpoint's p50" described a pin that did not exist. If a constant
  depends on a policy, co-locate them so they cannot be adopted separately.
- **Probe the real call shape, not a toy prompt.** `"say ok"` returned instantly
  from every backend and proved nothing. The bug only appears at
  `max_tokens: 2500`.
- **When two modules must share a policy but cannot share an import, move the
  policy to the side that both can reach.** `scripts/` is importable by
  `server/`; the reverse is not true for Railway workers.

## Verified in production

```
[LLM:market_implications] openrouter success model=deepseek/deepseek-v4-flash
[MarketImplications] Published 5 cards to intelligence:market-implications:v1 (23404ms)
```

`/api/health` went `SEED_ERROR` → resolved. **Bonus:** `[LLM:combined]` also
succeeded, at 20,561ms — it too exceeded the 15s clamp, so that stage had been
silently degrading to `fallbackNarratives` on every run.

## Related

- [A merged seeder fix is not live until its cron fires](../integration-issues/merged-is-not-ran-long-cron-seeders.md)
  — same session; the other way a correct fix fails to reach production.
- PR #5304 — routing/timeout fix (unmerged as of this writing).
