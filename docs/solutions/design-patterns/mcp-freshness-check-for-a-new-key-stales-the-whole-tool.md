---
title: "An MCP _freshnessChecks entry for a not-yet-seeded key marks every other dataset in that tool stale"
date: 2026-08-05
category: design-patterns
module: mcp-registry
problem_type: design_pattern
component: tooling
severity: medium
applies_when: "Adding a new dataset or cache key to an existing multi-dataset MCP cache tool, before its producer has ever run in production"
tags: [mcp, freshness, deployment-order, cache-tools, registry, staleness, get-economic-data]
---

# An MCP _freshnessChecks entry for a not-yet-seeded key marks every other dataset in that tool stale

## Context

An MCP cache tool bundles many datasets behind one call. `get_economic_data` reads 14 cache keys and returns them in one response. Its `_freshnessChecks` array declares which `seed-meta:*` keys gate the response's freshness (`api/mcp/registry/cache-tools.ts`).

The natural instinct when adding a dataset is to add a matching freshness check — the BIS datasets each have one, and per-dataset checks were added deliberately in the first place because an aggregate `seed-meta:economic:bis-extended` would report "fresh" when only one of three slices was current.

That instinct is right for a key whose producer is already running, and wrong for a brand-new one.

## Guidance

Do not add a `_freshnessChecks` entry for a cache key whose producer has never run in production. Add the key to `_cacheKeys` (so the data is served), and let the key's own health surface own freshness until the producer has published at least once.

The reason is in `evaluateFreshness` (`api/mcp/freshness.ts:22-83`). It is a single OR across every check, and a **missing** seed-meta counts as stale:

```js
if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
  hasAllValidMeta = false;
  stale = true;            // <- missing meta == stale
  continue;
}
```

and the result is one flag for the entire tool:

```js
return {
  cached_at: hasAnyValidMeta && hasAllValidMeta ? new Date(oldestFetchedAt).toISOString() : null,
  stale,
};
```

So between the Vercel deploy that ships the registry entry and the first Railway tick that writes the seed-meta, **every** call to that tool returns `stale: true` and `cached_at: null` — including calls that asked only for unrelated datasets via the `dataset` filter, because `_postFilter` narrows the `data` payload but never touches the envelope.

## Why This Matters

The blast radius is inverted from what the change looks like. The diff adds one dataset; the effect degrades the freshness signal on all 14, for every consumer, for as long as the deployment-order gap lasts. With a daily cron that is up to ~24 hours.

The deployment-order gap is structural, not a race to be tightened: Vercel ships on merge, Railway seeders run on their own cron. Any new key has this window.

The obvious mitigation does not apply. `FreshnessCheck` has a `contentFreshnessActivationKey` field (`api/mcp/types.ts:158`) that grants a deployment-order grace — but `evaluateFreshness` consults it only inside the `requireContentFreshness` block, so it bridges a missing *content-freshness* assessment, not a missing seed-meta. `/api/health` has its own bridge for the same problem (`ACTIVATION_MARKERS` + `ON_DEMAND_KEYS`), and that one *does* cover a missing key — which is why health is the right owner during the gap.

The precedent already points the same way: of the 14 datasets in `get_economic_data`, only 6 have freshness checks. The closest peer to any newly added FX or rates dataset — `ecb-fx-rates` — has none.

## When to Apply

At the moment of adding a new cache key to an existing multi-dataset MCP tool. The decision tree:

| Situation | Freshness check |
|---|---|
| New key, producer has never run in production | **No** — the tool-wide flag would be wrong for every other dataset during the deployment-order gap |
| Key whose producer is established, and its staleness genuinely means the tool's answer is stale | Yes |
| Key whose failure mode is a content freeze rather than a stopped producer | No — `_freshnessChecks` models `fetchedAt` age and `minRecordCount`, not observation age; `/api/health` owns content-age contracts |

A follow-up is legitimate: once the producer has been publishing for a while, adding the check is safe and the check is then worth having.

## Examples

The entry removed from `get_economic_data`, and the comment left in its place so the omission reads as a decision rather than an oversight:

```ts
_freshnessChecks: [
  { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
  // ...
  { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
  // No cbr-rates entry, matching its closest peer in this tool (ecb-fx-rates)
  // and 8 of the 14 datasets here. evaluateFreshness treats a missing
  // seed-meta as stale and ORs every check into ONE tool-level flag, so a
  // brand-new key would mark every UNRELATED dataset stale — with
  // cached_at: null — from the Vercel deploy until the first Railway tick.
],
```

The health-side bridge that *does* work for the same gap, for contrast — the producer writes a durable marker after its first successful publish, and the key is soft until then, strict forever after:

```js
// api/health.js
const ACTIVATION_MARKERS = {
  chinaCoverage: 'seed-activated:health:china-coverage',
  cbrRates: 'seed-activated:economic:cbr-rates',
};
```

Found by the API-contract reviewer during the review of [#6187](https://github.com/koala73/worldmonitor/pull/6187) (issue #6154), before the entry ever reached production.
