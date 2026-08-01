# 30-day review plan — Strait of Hormuz Transit Report, July 2026

Published 2026-07-27 (v1.0.0). Review window: through 2026-08-27, aligned with
the monthly comparison cadence of the SEO/AI-citation scorecard
(`docs/research/seo-ai-visibility/`). The pilot expands into more reports ONLY
if the expansion gate passes; a quiet month means iterate or stop, not publish
more editions on hope.

## What to measure

| Signal | Where | What counts |
| --- | --- | --- |
| Indexation | Google Search Console URL inspection (needs the credentialed access tracked as baseline Opportunity 1) | The report URL indexed; sitemap entry discovered; no canonical conflicts |
| Non-brand impressions | GSC query report, 28-day window | Impressions/clicks for the q07 cluster (`Strait of Hormuz live traffic tracker` and variants) and for report-shaped queries (`hormuz transit data`, `hormuz ship traffic numbers`) |
| AI citations | Manual four-platform audit per the reproduction contract in `docs/research/seo-ai-visibility/README.md` | Rerun q07 unchanged on ChatGPT Search, Perplexity, Google AI, Copilot; record whether the report URL (not just the homepage) is cited. A mention without a worldmonitor.app link is not a citation |
| Downloads | Umami events `research-cta` with targets `download-csv` / `download-json` | Distinct-session download counts |
| Engagement | Umami pageviews for `/research/…`, plus `research-cta` targets `dashboard`, `chokepoint-page`, `methodology` | Report pageviews; handoff clicks into the live chokepoint page and dashboard |
| Product outcomes | Umami `research-cta` targets `pricing` and `developer`; existing sign-up/checkout events with landing-page attribution | Assisted pricing views, API/MCP doc visits from the report |
| Accuracy | Re-fetch the PortWatch series for the observation window and diff against the committed snapshot | Upstream revisions beyond rounding → publish a correction with a version bump and dateModified change, never a silent edit |
| Citations in the wild | Backlink lookup + manual search for the report title | Who cited it, with what framing; misquotes get a correction request, not a rewrite |

## Checkpoints

- **Day 7 (2026-08-03):** indexation check; confirm sitemap pickup; verify the
  page renders and downloads serve in production; record first Umami counts.
- **Day 14 (2026-08-10):** q07 four-platform AI audit rerun (documented
  geography/locale/signed-in schedule); record report-URL citations
  separately from homepage citations.
- **Day 30 (2026-08-27):** full comparison in the next scorecard period
  (`--previous` against the 2026-07-27 baseline); accuracy re-check against
  upstream; expansion decision.

## Expansion gate (all four required, per #5667)

1. **Demand** — non-brand impressions or AI-answer citations for the report's
   query cluster, not just direct/social spikes.
2. **Indexation health** — indexed, canonical uncontested, no soft-404 signals.
3. **Useful engagement** — downloads plus dashboard/methodology handoffs, not
   undifferentiated pageviews.
4. **Credible product handoff** — measured movement into dashboard, API/MCP
   docs, or pricing from the report.

Pass → one follow-up edition (August 2026) using the same contract, and only
then consider a second report family. Fail → record what was learned in the
scorecard, fix the weakest link (content, distribution, or indexation), and
re-test with this same edition. Do not generate country/topic variants of this
report regardless of outcome (#5668 guardrail).
