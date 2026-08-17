---
title: "Corroboration counts publisher families, not feed labels"
date: 2026-08-10
category: best-practices
module: "World Brief gates, digest scoring, corroboration badges (#6428)"
problem_type: best_practice
component: digest_ranking
severity: high
applies_when: "Counting how many independent sources carried a story — a brief gate, a ranking boost, or an N-sources badge"
status: adopted-publisher-family-counting
tags: [corroboration, syndication, publisher-family, world-brief, ranking, replay-log]
---

# Corroboration counts publisher families, not feed labels

## Decision

**Every corroboration count reads distinct publisher families. `cluster.sources` stays the feed-label list for attribution and links, and is never counted directly.** The brief-lead threshold stays at **2 publishers**, chosen from the measurement below rather than carried over by default.

This is the correctness prerequisite that [source-label RRF needs independent corroboration](./source-label-rrf-needs-independent-corroboration.md) identified as missing. That record rejected a *new* ranking method for relying on label breadth; the two gates already shipping relied on exactly the same signal.

## What was wrong

`cluster.sources` is a list of deduplicated feed labels (`scripts/_clustering.mjs`). Nothing mapped a label to a publisher, and WorldMonitor runs many feeds per newsroom — nine BBC editions, eight Reuters desks, four CNBC verticals. Every count built on that list read one newsroom's own editions as that many independent sources:

| Consumer | Counted | Consequence |
| --- | --- | --- |
| `isBriefLeadEligible` | feed labels ≥ 2 | two editions of one newsroom cleared "corroboration as a hard requirement, not a tiebreaker" |
| `publisherCount` (now `publisherFamilyCount`) | max of three label counts | up to 72 ranking points for one publisher's breadth |
| `assignStoryIdentity` (`dedup.mjs`) | `Set` of labels | inflated `corroborationCount` → `importanceScore` (5 sources × 20 pts) |
| `computeEntityCorroborationSignals` | `Set` of labels | manufactured entity corroboration, which is the gate's *second* arm |
| `uniqueSourceCount`, "✓ N sources", "N sources", MULTI-SOURCE, CSV `Sources` | labels — or worse, **articles** | the number shown to a user overstated independence |
| `synthesisUserPrompt` (`_insights-brief.mjs`) | labels | the count fed to the LLM that **writes the published brief** |
| `get_news_clusters` `distinctSourceCount` + `min_sources` (MCP) | labels | contradicted its own published "distinct outlets ... not one outlet filing twice" |
| `get_keyword_spikes` diversity gate (`keyword-spike-core.js`, `trending-keywords.ts`) | labels | one newsroom's feeds alone could raise a spike alert |
| digest notification cooldown bypass (`digest-delivery-plan.mjs`) | labels | one newsroom's extra editions bought a story past the quiet period |

The client badges were the worst case: they read `sourceCount`, the **article** count, so one outlet republishing itself rendered as two sources. The last four rows were found by code review, not by the original sweep — the lesson is that "count the sources" is spelled a dozen different ways across a codebase this size, and grepping the obvious gate names finds only the ones you already knew about.

## Measurement

Two harnesses, because they answer different questions. Each computes both variants from **one** corpus per sample — the digest rotates, so measuring "before" and "after" in separate runs would compare different news.

**1. Retained replay log** (`digest:replay-log:v1:full:en:all:*`) — 5 days spanning 3 weeks, 683 ticks, 279,390 representative stories. Same `sources` label semantics; the population is the digest's dedup representatives rather than seed-insights' clusters.

| Metric | Labels ≥ 2 (before) | Families ≥ 2 (adopted) | Families ≥ 3 |
| --- | --- | --- | --- |
| Stories counted as corroborated | 60,964 (21.8%) | 40,557 (14.5%) | 18,005 (6.4%) |
| Ticks with ≥ 1 corroborated story | 100.0% | 99.9% | 99.9% |

**33.5% of everything the old gate called corroborated was a single publisher.** The most frequent offenders, by occurrence:

| Count | Label set | One publisher |
| --- | --- | --- |
| 9,162 | `Hacker News` + `YC News` | Hacker News (`news.ycombinator.com`) |
| 2,965 | `CNBC` + `CNBC Markets` | CNBC |
| 1,958 | `The Verge` + `The Verge AI` | The Verge |
| 1,144 | `Yahoo Finance` + `Yahoo Finance Commodities` | Yahoo Finance |
| 375 | `Reuters Business` + `Reuters Energy` | Reuters |

**2. Live pipeline** — `news:digest:v1:full:en` replayed through the real `clusterItems` → `selectTopStories` → `pickBriefCluster`, sampled every 10 minutes for 70 minutes (8 samples). Corpus-eligible clusters fall from 10–13 to 6–8 at families ≥ 2, and **all 8 samples retained a brief lead**. In the first sample, five of the thirteen "corroborated" clusters were one publisher — including `["Reuters US","Reuters Asia"]` and `["BBC Middle East","BBC World"]`.

## Why the threshold stays at 2

Two genuinely independent publishers is a strictly stronger bar than two labels, so the same number rejects more — which is the point. The measurement shows what each candidate threshold costs:

- **Families ≥ 2** removes 33.5% of false corroboration at a publication-rate cost of 0.1 percentage points (one tick in 683 lost its only corroborated story).
- **Families ≥ 3** buys no additional publication-rate headroom (also 99.9%) but shrinks the eligible pool 3.4× further, to 6.4% of stories. [#5947](https://github.com/koala73/worldmonitor/issues/5947) is the record of what a thin eligible pool costs: 35 consecutive dark briefs. Paying that risk for no measured gain is the wrong trade.

Raising the bar again is a decision for after the map covers cross-publisher syndication (below), not before.

## The map, and how it fails

`shared/publisher-families.js` carries the curated label → family table and resolves it. It **fails closed in the direction that never invents independence**: an unmapped label becomes its own namespaced family (`label:<name>`, case-normalized so one feed whose casing drifts between the client and server configs cannot become two publishers), so a new feed is never silently folded into another publisher's byline, and never disappears from the count either — it simply cannot corroborate anything but itself.

The table is an inline literal, not a `.json`. This module is reached by four runtimes, and the two JSON-import forms are mutually incompatible across them: `with { type: 'json' }` breaks the Vercel bundle, and a bare JSON import throws `ERR_IMPORT_ATTRIBUTE_MISSING` under Node 22+. `shared/ticker-extract.js` recorded that burn as a comment — a comment does not fail CI, and review caught this change re-introducing exactly it, so `tests/no-json-import-attributes-on-edge-path.test.mjs` now walks the real import graph from every `api/` entrypoint and fails there instead.

Curated data rots in three directions, so `tests/publisher-families.test.mjs` locks all three:

- **Dead entries** — a mapped label no feed config declares is a rename or a typo that silently stopped merging its publisher.
- **Missing entries** — any two feed labels resolving to the same publisher host must land in one family. This is derived from the feed configs, so the next feed added for a publisher already in the map fails the test instead of quietly inflating a count. It earned its keep immediately: it caught a Yahoo Finance pair the hand-written map missed.
- **Over-merges** — a family spanning several publisher hosts must declare why. Over-merging is the opposite failure: it *understates* corroboration, shrinking the eligible pool toward the #5947 dark-brief direction, and every other check here passes it. This one caught a Deutsche Welle feed-subdomain span on its first run.

Aggregator hosts (`news.google.com`, feedburner, megaphone) are excluded from that invariant — two labels sharing a syndication transport prove nothing about the publisher, so those merges are curated by hand or left separate.

## Known limit: cross-publisher syndication

This map collapses **one publisher's own labels**. It cannot see that an unrelated outlet reprinted a Reuters wire, because the feed label carries no information about the wire: the ingest parser stamps `item.source = feed.name` and drops the RSS `<source>` element that names the originating publisher. Recovering that is a parser change, not a map change, and it is tracked in [#6430](https://github.com/koala73/worldmonitor/issues/6430). Until then a corroboration count is an upper bound on independence — a much tighter one than before, but still an upper bound.

The same limit applies to the keyword-query Google News feeds ("Oil & Gas", "AI News") — 82 of the 366 labels in the server digest config — which identify a *query*, not a publisher. Where such a feed is named after a publisher (`Reuters Crypto`, `Bloomberg Crypto`, `a16z Insights`) it is folded into that publisher's family — the conservative direction. The rest stay their own family under the fail-closed default.

## Related

- [source-label-rrf-needs-independent-corroboration](./source-label-rrf-needs-independent-corroboration.md) — the record that named this failure mode and deferred [#5991](https://github.com/koala73/worldmonitor/issues/5991) for it
- [#5947](https://github.com/koala73/worldmonitor/issues/5947) — why the brief reserves a slot for a corroborated cluster, and why the eligible pool must not go thin
- [#6430](https://github.com/koala73/worldmonitor/issues/6430) — the parser drops the RSS `<source>` element that would close the cross-publisher half
- [#5981](https://github.com/koala73/worldmonitor/issues/5981) — entity-resolution-first correlation epic
