---
name: country-briefing
description: Build a country risk briefing from World Monitor - instability score and its components, travel advisory, sanctions exposure, an AI-written assessment with citations, and IMF macro indicators. Use when the user asks how risky or stable a country is, or wants a briefing on one country.
---

# Country briefing

Build a briefing for one country from World Monitor data. Accept an ISO 3166-1 alpha-2 code (`JP`), an alpha-3 code (`JPN`) or an English country name (`Japan`).

## Tools

| Tool | Access |
|---|---|
| `get_country_risk` | subscription |
| `get_country_brief` | subscription |
| `get_country_macro` | free-account |

## Steps

1. Call `get_country_risk` with `country_code`. Read `cii.combinedScore` (0-100, higher means less stable), `cii.trend`, `cii.components`, `advisoryLevel`, `sanctionsActive` and `sanctionsCount`. Add `history_days: 30` when the user asks how the score has changed.
2. Call `get_country_brief` with the same `country_code` for the written assessment, its sources and its generation time.
3. Call `get_country_macro` with `countries: ["<code>"]` for growth, inflation, unemployment and fiscal balance.
4. Write the briefing in this order: risk score and trend, the components driving it, advisory and sanctions posture, the assessment's main points with citations, then the macro indicators with their reference year.

## Rules

- If `upstreamUnavailable` is true, say the risk snapshot is degraded. Never read missing data as low risk.
- Label each section as measured index data, official advisory, AI-written assessment or IMF statistics.
- If a subscription tool is refused, deliver the sections that did load and name the ones that did not.
- Give dates for every figure. Do not predict events.
