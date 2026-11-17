---
title: "Stress-Test a Supply Chain Against a Chokepoint Disruption"
description: "Choose a disruption scenario, set country and closure severity, inspect coverage and save the assumptions without treating modeled scores as financial losses."
metaTitle: "Supply Chain Scenario Engine Stress Test | World Monitor"
keywords: "supply chain scenario engine, geopolitical stress test, chokepoint scenario, supply chain risk simulation, trade exposure analysis"
audience: "Supply chain teams, commodity desks, risk managers, policy analysts"
heroImage: "/blog/images/blog/stress-test-supply-chain-scenario-engine-worldmonitor.jpg"
pubDate: "2026-06-13"
modifiedDate: "2026-11-17"
---

To stress-test a supply chain, choose a disruption scenario, define the country and closure severity, and inspect the evidence behind the result. World Monitor's PRO Scenario Engine supports named templates and country/sector coverage details. Its scores describe modeled exposure; they are not shipment delays, dollar losses or probabilities of disruption.

*Cover: an archived dashboard image. Displayed readings and interface details are illustrative, not current observations.*

## Separate today's observations from the scenario

Start with a planning question: which exposures should our team review if a shipping corridor becomes less available? Record current observations and their source dates before opening a hypothetical scenario.

The scenario overlay applies assumptions to exposure data. It is not a report that the corridor has closed. Your supplier locations, booked routes and inventory constraints remain necessary: the dashboard does not know your company's full supply chain.

## Choose supported inputs

Open the **Supply Chain** panel and choose an available physical chokepoint template. Select the country scope and closure severity. Physical severity accepts integer values from 0 through 100; the template supplies a default when an override is omitted.

Templates remain curated. Country and physical closure controls do not make this an unrestricted simulator. Duration is descriptive metadata and does not change the score calculation. Tariff scenarios use different logic and do not accept a physical severity override.

Scenario runs require PRO access. Check [current plans](/docs/pricing) for the appropriate access and use requirements.

## Run, then inspect coverage first

A job can be queued, processing, completed or failed. Do not treat failure as zero impact or assume a fixed completion time. When a result is available, read **Evidence coverage** before interpreting its ranking.

“Complete within seeded scope” does not mean complete global trade coverage. Missing, malformed, incomplete-route and unseeded records must remain distinct from evaluated zero impact. A partial score is a lower bound over the evidence available for that run, not proof of low exposure.

The data basis matters too. Flow-weighted scores use recorded trade shares with modeled routes; geographic fallback routes are a different basis. Neither is a record of your actual shipment booking. Cache production dates are not necessarily trade observation dates.

## Read the score in its own units

| Result | Meaning |
| --- | --- |
| Raw impact | Modeled exposure units, not money or lost trade. |
| Relative ranking | Normalized against returned results, not a percentage loss. |
| Coverage | Which requested country/sector records could be evaluated. |
| Duration | Template context, not an extra multiplier in the calculation. |

For a physical scenario, an exposure contribution depends on the exposure score, closure fraction and cost multiplier. Relative rankings also depend on normalization. Doubling severity does not mean the displayed relative percentage must double. The [Scenario Engine methodology](/docs/scenario-engine) provides the calculation details.

## Compare two assumptions fairly

As a hypothetical exercise, run the same physical template and country at 50% and 100% closure. Retain other assumptions. Compare raw impact and coverage as well as rankings; do not invent expected output values.

If source evidence changes between runs, the comparison has another variable. Save the dates and coverage, and say when the evidence base differs. Then ask which actual supplier or route is implicated and what operational information would change the plan.

The model helps prioritize those questions. It does not automatically choose a new route, price a contract or recommend a trade.

## Save the run and return to baseline

Use **Download scenario JSON** to retain the captured run. Inspect the file for its inputs, raw score units, coverage records and dates. Keep unanswered questions in your team's own notes beside it.

This download is a scenario snapshot, not a universal data export or a spreadsheet/BI integration. Use the **Dismiss scenario** control to clear the hypothetical state and return to the baseline view.

For current observations, use the [shipping chokepoint workflow](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/). For programmatic access, see the [Scenarios API](/docs/api-scenarios).

The public [scenario methodology](https://github.com/koala73/worldmonitor/blob/5c50df116c/docs/scenario-engine.mdx) documents the behavior behind this guide.

Inspect the published observations for the [Taiwan Strait](https://www.worldmonitor.app/chokepoints/taiwan-strait/), [Suez Canal](https://www.worldmonitor.app/chokepoints/suez-canal/), [Bab el-Mandeb](https://www.worldmonitor.app/chokepoints/bab-el-mandeb/), [Panama Canal](https://www.worldmonitor.app/chokepoints/panama-canal/) or [Strait of Hormuz](https://www.worldmonitor.app/chokepoints/strait-of-hormuz/) before choosing the corresponding hypothetical scenario.

## Frequently Asked Questions

**Can I choose a country and closure severity?**

Yes, within supported physical-template controls. Tariff scenarios have different rules; duration is descriptive.

**Does the result estimate dollars lost?**

No. It reports modeled exposure. Commercial terms and company-specific logistics evidence are needed for a loss estimate.

**What does partial coverage mean?**

Some requested evidence was unavailable or unsuitable. Read record statuses and do not present a partial total as low exposure.

**Can I save a run for review?**

Download scenario JSON preserves the captured scenario and evidence context. It does not imply every dataset supports the same export.

Open [World Monitor](https://www.worldmonitor.app), choose a scenario and inspect its coverage before using the ranking.
