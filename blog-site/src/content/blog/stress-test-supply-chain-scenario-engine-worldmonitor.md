---
title: "Stress-Test Your Supply Chain with WorldMonitor's Scenario Engine"
description: "How Scenario Engine turns chokepoint, trade, and HS2 exposure data into async stress tests for Hormuz, Taiwan, Suez, Panama, tariffs, and grain routes."
metaTitle: "Supply Chain Scenario Engine Stress Test | WorldMonitor"
keywords: "supply chain scenario engine, geopolitical stress test, chokepoint scenario, supply chain risk simulation, trade exposure analysis"
audience: "Supply chain teams, commodity desks, risk managers, policy analysts"
heroImage: "/blog/og/stress-test-supply-chain-scenario-engine-worldmonitor.png"
pubDate: "2026-06-13"
---

Most supply-chain dashboards answer a live-state question: which ports, corridors, commodities, or countries are under pressure right now?

That is necessary, but it does not answer the planning question:

> What breaks if the next chokepoint closes, tariff shock lands, or weather event cuts capacity?

WorldMonitor's Scenario Engine is built for that what-if layer. It takes named disruption templates, runs them through the supply-chain exposure graph, and returns the affected chokepoints, sectors, and countries so analysts can compare the projected impact against the live baseline.

This is not a free-form simulator with arbitrary sliders. Version 1 is deliberately constrained: curated templates, fixed assumptions, async jobs, and explicit output fields. The constraint is useful. It makes every run comparable and keeps the conversation anchored to a named scenario instead of a hand-tuned model.

## What Scenario Engine does

Scenario Engine lives in the Supply Chain panel. A PRO user selects a pre-built scenario, starts a run, and the system computes impact through the current chokepoint and trade-exposure data.

The result can paint affected chokepoints on the map, highlight impacted countries, and inject a scenario summary into the Supply Chain panel. Programmatic users can do the same through the scenarios API: list templates, run a scenario, then poll job status until the worker returns a terminal state.

A completed result includes:

- affected chokepoints
- top affected seeded reporter countries
- relative weighted impact scores
- duration, disruption percent, and cost-shock multiplier metadata
- projected scenario state that can be dismissed back to the live baseline

The important word is relative. `totalImpact` is not a dollar amount, and it is not a forecast of GDP loss. It is a weighted exposure score for comparing which countries look more exposed under the named template.

## The shipped scenario templates

The live template catalog is defined in the codebase, and the API response should be treated as the source of truth. Current templates include:

| Template | Core question |
|---|---|
| Taiwan Strait Full Closure | What happens to electronics, machinery, and vehicle routes if East Asia traffic is blocked? |
| Suez + Bab el-Mandeb Simultaneous Disruption | What happens if the Red Sea corridor is heavily impaired? |
| Panama Canal Drought - 50% Capacity | What happens when climate stress cuts a key canal's throughput? |
| Hormuz Strait Tanker Blockade | What happens when Persian Gulf energy and petrochemical exports are severed? |
| Russia Baltic Grain Export Suspension | What happens to cereals and oilseeds when a grain route is suspended? |
| US Tariff Escalation - Electronics | What happens when a tariff shock hits electronics without a physical chokepoint closure? |

The templates cover conflict, weather, sanctions, and tariff-shock categories. The type system leaves room for infrastructure and pandemic categories, but those categories do not ship templates today.

## How a run works

The workflow is async because the edge function does not compute the full impact inline. It enqueues a job and returns a `jobId`. The worker processes that job and writes a result. The caller polls for status.

The lifecycle is straightforward:

1. List available templates.
2. Run one template, optionally scoped to a single ISO-2 country.
3. Poll status until it is `done` or `failed`.
4. Read the result and compare it with live chokepoint status.
5. Dismiss the scenario state when finished.

If no country is supplied, v1 computes across the seeded reporter set: US, CN, RU, IR, IN, and TW. That scope is a current implementation detail, not a claim that only those countries matter. It keeps the first version bounded while the underlying exposure graph expands.

The run endpoint is PRO-gated. It also has gateway rate limits and queue backpressure, because scenario runs consume worker capacity and Redis queue space.

## What the impact score means

For physical chokepoint scenarios, the worker combines exposure, disruption percent, and cost-shock multiplier. For tariff-shock scenarios without physical chokepoints, it uses vulnerability and cost-shock logic instead.

That distinction matters. A Hormuz run is about physical energy-route exposure. An electronics tariff run is about cost shock and trade vulnerability. Both can be supply-chain scenarios, but the transmission path is different.

Treat the output as a ranked diagnostic:

- Which countries rise to the top?
- Which chokepoints turn into the critical visual state?
- Which HS2 sectors are in scope?
- Does the template affect all sectors or a named set?
- Does the result agree with your supplier, route, or commodity watchlist?

The value is not that the engine predicts the exact future. The value is that it forces a consistent stress test before the crisis hits.

## A practical workflow

Start with one decision. For example: should a procurement team pre-book alternate logistics capacity before the next Red Sea escalation?

Then run the workflow:

1. Open the live Supply Chain panel and record the current chokepoint state.
2. Run the closest scenario template, such as Suez + Bab el-Mandeb.
3. Note top impacted countries and any sectors in scope.
4. Compare the output to supplier locations, shipping lanes, and commodity exposure.
5. Decide which mitigations are cheap enough to activate early.
6. Save the assumptions, not just the result.

The last step is the one teams skip. A stress test is only useful when someone can later ask, "What did we believe, what changed, and which signal would have invalidated the plan?"

Use the [maritime chokepoint explainer](/blog/posts/what-is-a-maritime-chokepoint/) and the [global trade route monitoring guide](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/) as inputs before choosing a template.

## Source transparency

Scenario Engine sits on top of WorldMonitor's chokepoint registry, live chokepoint status, HS2 exposure caches, and supply-chain panel state. The template catalog is curated in code. The job queue and worker output are explicit: callers can see pending, processing, done, and failed states rather than receiving an opaque spinner.

That is the right shape for geopolitical modeling. A useful stress test should show its assumptions, expose its scope, and avoid pretending a relative impact score is a dollar-denominated forecast.

## Frequently Asked Questions

**Is Scenario Engine free?**

The Supply Chain panel is available on public variants, but Scenario Engine activation is PRO. The API also enforces PRO entitlement for scenario runs.

**Can I create arbitrary custom scenarios?**

Not in v1. The shipped engine uses curated templates. That keeps comparisons stable and prevents users from overfitting a scenario to the answer they wanted.

**Does `totalImpact` mean dollars lost?**

No. It is a relative weighted impact score. Use it to rank exposure inside a template, not as a financial loss estimate.

---

**Run scenarios before the headline, not after it. The best supply-chain stress test is one your team has already argued through.**
