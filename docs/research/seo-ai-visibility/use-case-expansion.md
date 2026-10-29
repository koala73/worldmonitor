# Use case expansion

## Goal and execution prompt

Expand WorldMonitor's use case library around distinct monitoring tasks supported by the product. Map each page to an audience, search intent, decision, and practical workflow. Include relevant data sources, a worked example, coverage limits, related pages, and a direct product link. Reuse the publishing system, prevent overlap with existing pages, verify crawlability and rendered output, and deliver a PR with screenshots. Prioritize product fit. Do not invent search volumes or promise rankings.

## Page selection

The initial library covers country risk, breaking-news verification, and supply-chain disruption. The nine additions below serve narrower decisions with different outputs. Selection is based on documented product coverage, not measured keyword demand. The committed Search Console snapshot supplies a historical baseline, but no paid keyword-volume dataset was used.

| Page slug and target intent | Reader and decision | Boundary with existing content |
| --- | --- | --- |
| `monitor-maritime-security` | Shipping security analyst reviewing threats along a transit segment | Passage evidence and operator questions, rather than downstream supply-chain impact |
| `monitor-aviation-disruptions` | Travel operations team reviewing airports and airspace notices | Airport validity windows and airline confirmation, rather than national risk |
| `monitor-energy-infrastructure-risk` | Energy analyst reviewing physical asset exposure | Asset status and transmission path, rather than general supply-chain monitoring |
| `monitor-natural-disasters` | Continuity team reviewing hazard exposure at a facility | Hazard observation and local impact confirmation |
| `monitor-internet-outages` | Infrastructure analyst reviewing regional connectivity dependencies | Service scope, possible network dependencies, and recovery confirmation |
| `monitor-conflict-escalation` | Security researcher comparing reported activity with a baseline | Event dates, independent evidence, and change assessment |
| `monitor-civil-unrest` | Local operations team reviewing workplace access | Protest timing and local transport restrictions, rather than a national risk score |
| `monitor-humanitarian-access` | Coordination team preparing access questions | Programme-area constraints, displacement reporting periods, and local confirmation |
| `monitor-critical-mineral-supply-risk` | Procurement analyst reviewing mineral dependencies | Mining versus refining versus contracted supply |

Each target phrase is an intent hypothesis. The page title and route express the task directly. Each page has an original example, four task-specific steps, a distinct output, and a question with a visible answer that matches its structured data.

## Historical search baseline

The [October 27 Search Console snapshot](gsc/2026-10-27.md) reports all four existing use-case URLs indexed, including the hub. For September 29 through October 26, their page rows total 215 impressions, 99 non-brand impressions, and 2 clicks. The individual impression counts are 88 for supply-chain disruptions, 77 for country risk, 28 for the hub, and 22 for breaking-news verification. These are historical page-row metrics, not market keyword volumes or a current production check.

This supports expanding useful task coverage while measuring whether the new pages attract qualified visits. It does not establish demand for any specific new title.

## Product evidence

- `src/config/map-layer-definitions.ts` defines the linked map layers and variant availability.
- `docs/data-sources.mdx` describes providers, publication delays, and coverage limits.
- `docs/maritime-intelligence.mdx`, `docs/natural-disasters.mdx`, and the linked panel and methodology guides explain the product views.
- The existing `scripts/build-use-cases.mjs` helpers own page metadata, structured data, and product attribution.

The new pages use public map context. They do not claim automated alerts, private supplier data, safe travel decisions, or universal live coverage. Examples are explicitly illustrative. Topic-specific guides link to source documentation and related workflows.

## Publishing and verification

The use case hub links to all twelve pages. The corpus manifest includes each route, and sitemap discovery reads the generated HTML. New content records use the existing HTML shell and attribution helpers. Both production and preview build triggers include the content file. The family modification date includes its Git date and the content version fallback.

Acceptance requires generated HTML with a unique title and description, a self-canonical URL, visible steps matching HowTo data, a visible FAQ matching FAQPage data, valid source and sibling links, and a dashboard link with registered layers and attribution. Capture desktop and mobile output before PR delivery.

## Measurement after publication

Use Search Console to compare indexed pages, impressions, clicks, and query overlap for this route family. Use the existing `use-case-product-cta-click` event and campaign slug to compare product entries by workflow. Establish a baseline before judging changes. Review the first complete 28-day period after indexing, then a second comparable period. Do not attribute a traffic change to these pages without checking seasonality and other site changes.

Consolidate pages if queries and reader decisions overlap. Improve weak pages using actual queries and product-entry evidence before adding more. Google recommends useful, original content for readers and warns against scaled pages that add little value: [helpful content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) and [scaled content policy](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content).
