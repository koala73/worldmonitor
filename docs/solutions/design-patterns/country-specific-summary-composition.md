---
title: Compose country-specific summaries from existing country data contracts
date: 2026-07-14
category: design-patterns
module: Country Intel
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - A country needs a bespoke overview without changing generic country pages
  - Existing domain clients already expose the needed data and attribution
tags: [country-intel, china, source-attribution, progressive-loading]
---

# Compose country-specific summaries from existing country data contracts

## Context

A country deep dive can need a domain-specific overview that does not fit the generic economic rows. The durable pattern is to compose that overview from the country page's existing data contracts, rather than creating a parallel aggregate endpoint or silently re-fetching the same sources.

This was applied to the China overview opened in [Issue #5277](https://github.com/koala73/worldmonitor/issues/5277) and is pending in [PR #5297](https://github.com/koala73/worldmonitor/pull/5297) at documentation time.

## Guidance

Create a small, UI-owned view model with one group per required domain. `ChinaCountrySummaryGroup` gives every group an explicit state (`loading`, `available`, `partial`, `stale`, or `unavailable`) and holds its source-attributed signals in `src/components/CountryBriefPanel.ts`. Keep the state calculation with the orchestration code so the panel only renders the model it receives.

```ts
function chinaSummaryState(signals, expectedSignals) {
  if (signals.length === 0) return 'unavailable';
  if (signals.every((signal) => signal.stale)) return 'stale';
  return signals.length < expectedSignals || signals.some((signal) => signal.stale)
    ? 'partial'
    : 'available';
}
```

In `src/app/country-intel.ts`, reuse the existing IMF and stock promises, then compose the dedicated groups from the already established China macro, BIS credit, shipping, sector-exposure, energy, aviation, and hazard paths. Every displayed signal keeps its source and preserves an observation or retrieval time only when its contract supplies one; the card must not fabricate one from the brief-open time or turn a freshness timestamp into a health claim.

Guard asynchronous updates with both the request token and the current country code before rendering. `CountryIntelManager` only publishes China groups while the same request is current and the active panel still represents `CN`; `CountryDeepDivePanel.updateChinaCountrySummary` applies the same code check. This prevents a late China request from populating a country selected afterward.

Do not bypass existing access boundaries for a richer country card. `fetchMultiSectorExposure` relies on `fetchCountryChokepointIndex`, which returns an empty result without premium access. Treat the absent optional signal as `partial` or `unavailable`, while retaining public data such as shipping rates where it is already public.

Render source text with DOM text nodes, per-group polite status regions, and a responsive single-column layout. The regression test in `tests/china-country-summary.test.mts` exercises all five groups, stale and partial states, a country change, lower-case country codes, and an attribution string that resembles markup.

## Why This Matters

Reusing established contracts keeps source-specific normalization, entitlement rules, cached hydration, and failure handling in one place. The explicit view model also makes degraded states visible instead of presenting a mix of late, stale, and unavailable values as a complete summary.

## When to Apply

- A single country needs a clear, domain-oriented overview alongside the unchanged generic page.
- The required facts already have maintained clients, hydration, or RPC contracts.
- The source set can be incomplete, stale, gated, or arrive after a user changes country.

## Examples

For China, the card contains five independently rendered groups: macro and policy, market and credit, trade and supply chain, energy, and availability. A group may render a partial result when one of its underlying public sources is absent, while a premium-gated trade detail remains absent for anonymous users. The generic page receives no China-specific card for another country.

## Related

- [Reject degraded China macro snapshots at the seed publish boundary](../logic-errors/reject-degraded-china-macro-seed-publication.md)
- [Issue #5277](https://github.com/koala73/worldmonitor/issues/5277)
