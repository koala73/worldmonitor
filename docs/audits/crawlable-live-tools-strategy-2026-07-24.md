# Crawlable Live Tools for World Monitor

## Decision

World Monitor should build search-intent tools as progressively enhanced pages on the main domain, not as a disconnected SEO subdomain. The static page must be useful and source-labelled before JavaScript runs; live API data should add utility without becoming the only crawlable content.

The first implementation upgrades the existing country corpus:

- 196 crawlable country pages retain the committed, dated Country Resilience Index snapshot.
- Each page adds a current Country Instability Index result from the anonymous browser API.
- The page explicitly separates structural resilience from fast-moving instability.
- API failures leave the dated reference visible and labelled instead of showing placeholder data as live.
- The primary conversion is contextual: open the same country in the full dashboard dossier.

## Why This Beats a Generic "Live Conflict Tracker" Page

The homepage already explains and launches the global dashboard. A second generic conflict-map landing page would compete with it and offer little new utility.

Country pages match a narrower job: "What is the current risk picture for this country?" They also have a natural hub-and-spoke structure, proprietary methodology, stable source material, a live enhancement and a direct product handoff.

## Opportunity Scorecard

Scores use a 1-5 scale. Maintenance is scored inversely: 5 means low maintenance.

| Priority | Tool surface | Demand | Audience | Unique data | Product path | Feasibility | Maintenance | Links/share | Total |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Live country risk monitor on `/countries/{country}/` | 5 | 5 | 5 | 5 | 5 | 4 | 4 | 33 |
| 2 | Live chokepoint status on `/chokepoints/{waterway}/` | 4 | 5 | 5 | 5 | 4 | 4 | 5 | 32 |
| 3 | Crisis snapshot by country pair or region | 4 | 5 | 5 | 5 | 3 | 3 | 5 | 30 |
| 4 | Natural-hazard pulse for earthquakes, fires and volcanoes | 5 | 4 | 3 | 4 | 4 | 4 | 4 | 28 |
| 5 | Airspace disruption and military-flight activity checker | 4 | 4 | 4 | 4 | 3 | 3 | 5 | 27 |

## Implemented Tool Contracts

### 1. Live chokepoint status

Enhance each existing chokepoint page with current transit, disruption and freshness data. Keep the committed route and geographic context crawlable. Never label a chokepoint "disrupted" without a timestamp and a real API response.

Implemented across all 13 canonical `/chokepoints/{waterway}/` routes. The live
panel uses the maintained chokepoint-status RPC, matches the canonical ID,
labels partial transit coverage, and fails closed when the response declares an
upstream outage.

### 2. Crisis snapshot

Target a specific decision such as "Iran Israel escalation tracker" or "Red Sea security monitor," not a second global dashboard. Combine a crawlable methodology and source guide with a current, bounded incident summary and a map deep link.

Implemented as a four-entry allowlist at `/crises/`: Iran–Israel escalation,
Ukraine war, Red Sea security, and Sudan conflict. Trackers compose
country-level HAPI/HDX humanitarian summaries. They aggregate only compatible
reference periods and name missing coverage instead of converting it to zero.

### 3. Natural-hazard pulse

Let a visitor choose a country or region and see current earthquakes, fires and severe-weather alerts. The static page should explain alert thresholds and sources; dynamic results must expose occurrence time and source.

Implemented at `/tools/natural-hazard-pulse/` as a worldwide view with optional
country bounding-box filtering. The page calls the seeded natural-events
contract, retains per-event source names, excludes closed/malformed events, and
distinguishes an authoritative zero from an unavailable snapshot. Country
options whose maintained envelopes exceed the bounded-query budget are omitted.

### 4. Airspace disruption checker

Answer whether a country's airspace or major airports show current disruption. Separate commercial disruption from military-flight activity, and avoid implying intent from aircraft presence alone.

Implemented at `/tools/airspace-disruption-checker/`. Commercial monitored
airport coverage and bounded military-flight observations render as independent
sections and can fail independently. Unknown airport telemetry is not counted
as normal, military returns are capped at 100 in the page model, and the page
does not produce a combined threat score. The selector exposes only maintained
country envelopes no larger than 45 degrees latitude by 60 degrees longitude.

## Delivery Shape

- Shared browser enhancement: `scripts/crawlable-live-tools.mjs`
- Curated crisis scope: `shared/crawlable-crises.json`
- Deterministic generator: `scripts/build-crawlable-corpus.mjs`
- Static discovery: `/tools/`, `/crises/`, corpus manifest, root sitemap
- Deployment posture: static prefixes bypass the SPA catch-all and use public
  one-hour revalidation
- Authentication: session-gated RPCs reuse the anonymous `wm-session`
  mint-and-retry path; no keys enter generated HTML
- Failure posture: loading, ready, partial, and unavailable states; current
  selections own their request controller so late responses cannot overwrite a
  newer country

## Deferred Expansion

- Do not add crisis routes without a reviewed, unique geographic boundary and
  stable explanatory copy.
- Do not generate per-country hazard or airspace URLs; the selector tools cover
  that intent without creating thin pages.
- Add product analytics only through a separately reviewed telemetry contract.

## Guardrails

- Use subfolders on `worldmonitor.app`; do not split authority onto an SEO subdomain.
- Do not generate pages without unique source-backed content.
- Do not fetch live data during the build. Builds must remain deterministic.
- Show timestamps and methodology versions beside dynamic scores.
- Fail closed: unavailable data is unavailable, never zero or "normal."
- Keep JSON-LD aligned with the static visible snapshot; do not serialize volatile scores into build-time schema.
- Use the existing anonymous browser session contract. Do not expose API keys.
- Link every tool from a hub and back into the exact dashboard state.

## Measurement

Track each page family separately:

- indexed pages and crawl errors;
- non-brand impressions for country risk, country instability and geopolitical risk queries;
- live-tool success and unavailable rates;
- refresh usage;
- click-through to the country dossier;
- Pro or API conversion after a tool-assisted session.

Expand a page family only after the first cohort shows indexation, useful engagement and a healthy live-data success rate.
