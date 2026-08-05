---
title: "Critical Minerals and HHI: Measuring Supply Concentration Risk"
description: "How WorldMonitor uses 2024 production data and the Herfindahl-Hirschman Index to explain supply concentration in lithium, cobalt, rare earths, and more."
metaTitle: "Critical Minerals HHI Supply Risk Explained | WorldMonitor"
keywords: "critical minerals HHI, Herfindahl Hirschman Index minerals, supply concentration risk, rare earth supply risk, lithium cobalt gallium germanium"
audience: "Supply chain teams, policy analysts, commodity researchers, semiconductor and battery strategists"
heroImage: "/blog/images/blog/critical-minerals-hhi-supply-risk-explained.jpg"
pubDate: "2026-06-13"
modifiedDate: "2026-07-22"
---

Critical minerals are not risky only because demand is rising. They are risky because supply is often concentrated in a small number of producing countries, processing hubs, or firms.

That concentration creates a simple but powerful question:

> How dependent is this supply chain on one or two producers?

WorldMonitor's Critical Minerals view uses the Herfindahl-Hirschman Index, or HHI, to make that concentration visible. The current dataset uses 2024 global production entries for minerals such as lithium, cobalt, rare earths, gallium, and germanium, then computes concentration and risk labels from producer shares.

This is a methodology explainer. It is not another dashboard tour. The useful idea is the measurement: HHI turns "China dominates rare earths" or "DRC dominates cobalt" into a comparable concentration score.

## What HHI measures

HHI is a concentration index. To compute it, take each producer's market share in percentage points, square it, and sum the squared shares.

Example:

```text
Producer shares: 50%, 30%, 20%
HHI = 50^2 + 30^2 + 20^2
HHI = 2500 + 900 + 400 = 3800
```

A perfectly fragmented market trends toward zero. A single-producer market scores 10,000.

WorldMonitor's supply-chain scoring code labels HHI like this:

| HHI range | Risk label |
|---:|---|
| 0 to 1499 | low |
| 1500 to 2499 | moderate |
| 2500 to 4999 | high |
| 5000 and above | critical |

Those labels are blunt by design. HHI is not a complete mineral-security model, but it is an excellent first screen for concentration.

## Why concentration matters

Concentration risk shows up in several ways:

- Export controls can affect a large share of global supply at once.
- A mine disruption can matter more when substitute producers are limited.
- Processing concentration can create dependency even when mining is more distributed.
- Buyers have less bargaining power when alternatives are thin.
- Industrial policy becomes more urgent when a single producer controls a strategic input.

For batteries, semiconductors, defense manufacturing, renewable infrastructure, and grid hardware, mineral concentration is not a niche issue. It is a planning constraint.

## What WorldMonitor tracks today

The current Critical Minerals dataset includes 2024 production rows for:

- lithium
- cobalt
- rare earths
- gallium
- germanium

For each mineral, WorldMonitor groups production by mineral, sums producer tonnes, computes producer shares, computes HHI, assigns a risk rating, and displays the leading producer countries.

The production dataset is static and cached for 24 hours. That is appropriate for this use case because annual production concentration is not a minute-by-minute signal. A live dashboard can still combine the concentration score with fresher signals, such as export restrictions, shipping disruptions, trade policy, or commodity news.

## How to read the score

HHI is best used as a triage tool.

If a mineral has low concentration, the first-order supply question may be price, demand, logistics, or substitution. If it has critical concentration, the first-order question is dependency.

Ask:

- Who are the top producers?
- Is production concentrated, processing concentrated, or both?
- Are top producers politically aligned with buyer countries?
- Is the mineral tied to batteries, chips, defense, grid equipment, or energy transition infrastructure?
- Are there export controls, sanctions, chokepoint, or freight risks layered on top?
- Is there a substitute, stockpile, recycling pathway, or alternate chemistry?

The score tells you where to look first. It does not finish the analysis.

## HHI in a supply-chain workflow

A practical workflow:

1. Start with the mineral list relevant to your product or country strategy.
2. Sort by HHI and risk label.
3. Identify the top producer countries.
4. Overlay trade policy, sanctions, and export-control signals.
5. Check chokepoint and freight exposure for the trade route.
6. Record which suppliers, factories, or sectors depend on the mineral.
7. Decide whether to diversify, stockpile, redesign, hedge, or monitor.

That last step depends on the business. A government analyst may recommend strategic stockpiles. A manufacturer may redesign around substitutes. A commodity desk may watch export-control headlines. A logistics team may map routes and ports.

HHI gives all of them a common starting point.

## What HHI does not capture

HHI has limits.

It does not capture:

- reserve quality
- processing and refining bottlenecks
- company-level ownership
- environmental permitting
- labor conditions
- shipping distance
- inventory buffers
- substitutability
- recycling capacity
- price elasticity

It also treats current production shares as the concentration surface. That is often the right first cut, but strategic risk may sit downstream in processing or upstream in reserves.

That is why WorldMonitor places mineral concentration next to other supply-chain signals. A critical HHI score plus an export-control headline plus a chokepoint disruption is a different risk profile than a critical HHI score alone.

For operational follow-through, pair this structural concentration view with the [supply-chain scenario engine](/blog/posts/stress-test-supply-chain-scenario-engine-worldmonitor/) and the [maritime chokepoint explainer](/blog/posts/what-is-a-maritime-chokepoint/).

## Source transparency

WorldMonitor computes the Critical Minerals view from a committed 2024 production dataset and transparent scoring logic. The HHI formula is public in the codebase, and the risk thresholds are simple enough for a spreadsheet check.

The dataset currently focuses on a small set of strategically important minerals rather than claiming exhaustive global mineral coverage. That is the right tradeoff for a dashboard surface: make the concentration mechanism clear first, then expand coverage carefully.

The production inputs are derived from the U.S. Geological Survey's [Mineral Commodity Summaries 2025](https://www.usgs.gov/publications/mineral-commodity-summaries-2025), which publishes world production statistics for more than 90 nonfuel mineral commodities.

## Frequently Asked Questions

**Is HHI only for antitrust?**

No. HHI is widely associated with market concentration, but the same math is useful for supply-chain concentration. It answers how much production is concentrated among a few producers.

**Does a high HHI mean a shortage is imminent?**

No. High HHI means concentration. A shortage requires another trigger, such as demand growth, export controls, mine disruption, processing bottlenecks, or logistics stress.

**Why not use live prices instead?**

Prices are useful, but they can move after risk is already obvious. HHI is structural. It tells you where the system has limited redundancy before the shock arrives.

---

**Use HHI as the smoke alarm for concentration risk: it does not tell you the whole fire plan, but it tells you where to look first.**
