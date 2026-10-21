---
module: prediction-markets
date: 2026-07-30
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - "A producer published three labelled pools that were near-duplicates of each other — 75 records covering only 46 distinct markets"
  - "The pool named 'geopolitical' was topped by a Fed-rates market at $45.6M while genuine geopolitics sat below it"
  - "Downstream consumers that selected a pool by name were reading meaningless labels, with no test or health signal failing"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - forecast-engine
  - mcp-tools
tags:
  - classification
  - partition
  - catch-all
  - consumer-enumeration
  - seeder
  - prediction-markets
---

# A catch-all pool that becomes a real partition silently narrows every consumer that used it as "all"

## Problem

`scripts/seed-prediction-markets.mjs` published `prediction:markets-bootstrap:v1` as three
labelled pools — `geopolitical`, `tech`, `finance`. They were built as three *independent*
filters over one candidate array, and the first took no predicate at all:

```js
const geopolitical = filterAndScore(markets, null);                                        // NO filter
const tech         = filterAndScore(markets, m => m.tags?.some(t => TECH_TAGS.includes(t)));
const finance      = filterAndScore(markets, m => m.source === 'kalshi' || m.tags?.some(t => FINANCE_TAGS.includes(t)));
```

Because the fetch tag list is the **union** of all three domains, `filterAndScore(markets, null)`
made `geopolitical` a copy of everything fetched. The `tech` and `finance` tag lists separately
shared `economy`, `crypto`, and `business`, so those two overlapped as well.

Fixing that is easy. The expensive part is what fixing it *does to everyone downstream*.

## Symptoms

Measured against the live envelope on 2026-07-30:

| | before |
|---|---|
| records published | 75 |
| distinct markets | 46 |
| duplicate records | 29 (39%) |
| non-geopolitical titles in the "geopolitical" pool | 12 of 25 |
| top of the geopolitical pool by volume | *"Will no Fed rate cuts happen in 2026?"* ($45.6M) |

Nothing was red. No test failed, no health check fired — the seeder was fresh and publishing,
it was just publishing meaningless labels.

## What Didn't Work

**Enumerating consumers by grepping the obvious directories.** The initial sweep searched
`src/`, `server/`, and `api/` for readers of the pool keys and found five, all of which the
fix handled. It missed three more in `scripts/`, because a seeder reading another seeder's
output is not where you look for "consumers of an API". Adversarial review found them:

- `seed-forecasts.mjs` → `detectFromPredictionMarkets`
- `seed-forecasts.mjs` → `calibrateWithMarkets`
- `_forecast-resolution.mjs` → the title→endDate settlement index

All three read `.geopolitical` as a stand-in for "all markets" — correct while it *was* all
markets, silently wrong the moment it became a real partition. They would have lost every
macro, rates, crypto and AI anchor, degrading the exact calibration slice the fix existed to
unblock.

**Trusting the existing test suite to catch it.** Those three consumers had tests. Every one
built its fixture as `{ geopolitical: [...] }` — mirroring the old catch-all shape — so the
regression passed green. A fixture that encodes the buggy assumption cannot detect the bug.

## Solution

Assign exactly one primary category per record by explicit precedence, then treat every
whole-universe read as a distinct concern from a pool read.

```js
// One primary category, precedence-ordered. Disjoint tag lists mean no single TAG maps to
// two categories — but a market routinely carries tags from several lists, so the ORDER is
// load-bearing, not a tie-breaker.
export function classifyMarket(market) {
  if (isGeopoliticalMarket(market?.title) || hasCategoryTag(market?.tags, 'geopolitical')) return 'geopolitical';
  if (hasCategoryTag(market?.tags, 'tech')) return 'tech';
  if (hasCategoryTag(market?.tags, 'finance')) return 'finance';
  return DEFAULT_CATEGORY;
}

// The named alternative to `payload.geopolitical` for whole-universe reads.
export function allBootstrapMarkets(payload) {
  return [payload?.geopolitical, payload?.tech, payload?.finance].filter(Array.isArray).flat();
}
```

The `allBootstrapMarkets` helper is the load-bearing part of the fix, not the classifier.
It gives the three forecast consumers a name for what they actually wanted, so the next
person cannot reach for `.geopolitical` and accidentally mean "everything".

Opened as PR #5872 against issue #5733; unmerged as of this writing.

## Why This Works

The bug is not "the predicate was `null`". It is that **one field was serving two contracts**:
a *label* ("these are the geopolitical markets") and a *catch-all* ("these are all the
markets"). Both were satisfied while the pool was unfiltered, so nothing distinguished the
consumers relying on each. Splitting the contracts — one pool per label, one named helper for
the universe — makes the two reads impossible to confuse.

That is also why the fix's blast radius is entirely downstream: correcting the *label* is a
one-line change, and every bug it exposed was a consumer that had quietly been depending on
the *catch-all*.

## Prevention

**When a field stops being a superset, enumerate its readers before you change it.** The
search is for the semantic role, not the identifier — and it must cover every directory that
can read the value, including sibling scripts and seeders, not just the app tiers:

```bash
# Not just src/ server/ api/ — a seeder reading another seeder's output is still a consumer.
grep -rn "\.geopolitical" --include=*.mjs --include=*.ts --include=*.tsx . | grep -v node_modules
```

**Ask of each reader: does it want this LABEL, or does it want EVERYTHING?** Readers wanting
"everything" get the explicit union helper. Readers wanting the label keep the pool. A reader
you cannot classify is the one to investigate, not the one to skip.

**Distrust green tests whose fixtures encode the old shape.** Before believing a consumer is
unaffected, mutate it: revert the consumer to the old read and confirm its test goes red.

```js
// Guards the union. Reverting this consumer to `.geopolitical` turns the suite red.
it('calibrates from an anchor that lives in the finance pool, not geopolitical', () => {
  calibrateWithMarkets([pred], {
    geopolitical: [],
    tech: [],
    finance: [{ title: 'US recession by end of 2026?', yesPrice: 30, source: 'polymarket', volume: 50000 }],
  });
  assert.ok(pred.calibration !== null, 'a finance-pool market must still calibrate');
});
```

**Watch for the same trap in the deploy window.** A cached envelope keeps the *old* semantics
for its TTL after the new code ships, so a consumer rewritten to union the pools will
double- or triple-count while the pre-fix payload is still served. Dedupe the union rather
than assuming the payload matches the code that reads it.

**A self-consistency check is not a correctness check.** The integrity gate added here
re-runs the same classifier that built the partition, so it catches a regression in the
pipeline *shape* but can never tell you the taxonomy is right — an empty or misfiled pool is
trivially self-consistent. Say so in the code, or the next reader will over-trust a green
gate. Independent ground truth has to come from fixtures with hand-verified expected values.
