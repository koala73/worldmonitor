---
noindex: true
---

# Intelligence buying guides

The twenty-two guides serve readers choosing a monitoring tool. Six compare World Monitor with a named provider. Six describe alternatives to those providers. Ten select tools for distinct audiences.

## Selection method

The competitors were selected for overlap with World Monitor's core jobs, not measured market share. Liveuamap overlaps with regional mapped reporting. ACLED overlaps with conflict research and also supplies data used by monitoring tools. Dataminr overlaps with corporate event awareness. Recorded Future overlaps with geopolitical and security intelligence. Crisis24 overlaps with people and travel risk.

These products are not interchangeable. ACLED is often a complementary source rather than a direct dashboard replacement. Bloomberg and Palantir are not in this set because financial execution and internal operational-data integration are less direct substitutes for a public-source monitoring dashboard. This does not establish which companies generate the most lost deals. No account analytics, keyword-volume data, or customer interviews were supplied.

## Source ledger

Sources were checked on October 2, 2026. Recommendations compare documented scope with audience tasks. They are editorial judgments. No common alert-latency, accuracy, response-service, or API benchmark was run.

| Provider | Sources | Facts used |
| --- | --- | --- |
| World Monitor | `shared/product-facts.generated.json` and the capability ledger below | Rechecked October 16, 2026. See the ledger for each claim and its proof. |
| Liveuamap | [Official description](https://dc.liveuamap.com/about) | Geolocated reporting across conflict and other topics. Search-indexed official text was available; direct requests received a challenge or HTTP 403. No paid price or completeness claim was used. |
| ACLED | [Methodology](https://acleddata.com/conflict-data/knowledge-base/methodology); [myACLED access](https://acleddata.com/myacled-faqs) | Defined conflict-event methodology. Granularity, timing, and API entitlement depend on access level. Public dashboard access is not an unrestricted event-data license. |
| Dataminr | [Corporate Security](https://www.dataminr.com/products/corporate-security/); [facility monitoring](https://www.dataminr.com/products/pulse/corporate-security/facility-and-event-security/); [operational resilience](https://www.dataminr.com/products/pulse/corporate-security/operational-resilience/) | People and asset monitoring, operational-disruption awareness, documented playbooks and response workflows. No vendor speed or accuracy claim is treated as independently measured. |
| Recorded Future | [Geopolitical Intelligence](https://www.recordedfuture.com/products/geopolitical-intelligence); [Threat Intelligence](https://www.recordedfuture.com/products/threat-intelligence); [API overview](https://docs.recordedfuture.com/reference/get-started); [MCP tools](https://support.recordedfuture.com/hc/en-us/articles/55777121249043-Recorded-Future-MCP-Available-Tools) | Separate geopolitical and threat modules, location monitoring, specialist investigations, APIs and MCP. API entitlements follow licensed modules. MCP is not unique to World Monitor. |
| Factal | [About](https://www.factal.com/about/); [flat team fee](https://www.factal.com/roi/); [NGOs](https://www.factal.com/solutions/ngo/); [data API](https://www.factal.com/solutions/security-ai-safety-data/) | Checked October 16, 2026. AI detection, then verification by a 24/7 team of journalists; a flat fee per team covering unlimited users, notifications and location assets; free unlimited service for eligible life-saving NGOs; a 30-day trial; REST endpoints for live and historical incident data back to 2018. No price is published. Added because Factal was the top pick in 13 of 14 answers to a Dataminr-alternatives question and 14 of 14 to a Factal comparison, and no guide covered it. |
| Crisis24 | [Horizon](https://www.crisis24.com/platforms/crisis24-horizon) | Travel risk, people and site visibility, mass notification, assistance. The service and response scope must be confirmed in a contract. |

## World Monitor capability ledger

Every claim a guide makes about World Monitor must appear here with its proof. The first version of the guides used only the row "broad public-source context, API and MCP interfaces", so every World Monitor section fell back to "a supporting public-context dashboard". AI answer engines then cited those pages as the reason to choose the competitor. Rechecked October 16, 2026.

| Claim used in guides | Proof |
| --- | --- |
| The core map and panels are free, with no account | Free plan in `shared/product-facts.generated.json`; `/dashboard` loads signed out |
| Alerts reach Slack, Discord, Telegram, email, browser push, or a webhook | `channelType` literals in `convex/schema.ts`; [notifications reference](/api-notifications) |
| Webhooks are signed with HMAC-SHA256 | `scripts/lib/notification-webhook-signing.cjs`; `X-WM-Signature` contract in the notifications reference |
| Alert rules filter by event type, severity (all, high, critical), and country | `eventTypes`, `sensitivity`, and `countries` in the alert-rules table in `convex/schema.ts` |
| Delivery is real time, daily, twice daily, or weekly | `digestMode` in `convex/schema.ts`; `set-notification-config` in the notifications reference |
| Real-time alerts link to the original report, and email digests link every item | `formatEventLinkForText` in `scripts/notification-relay.cjs` renders `payload.link` on text channels; `formatDigestHtml` in `scripts/seed-digest-notifications.mjs` renders each title as a link to `s.link`. Chat digests (`formatDigest`) name each item's sources without a link, so guides must not say chat digests link items. |
| Alerts and digests need a paid plan | "Scheduled AI digest + alert rules engine" in the Pro plan in product facts; PRO gate in the notifications reference |
| REST API, Python, Go, and Ruby SDKs, an npm CLI, and an MCP server | `sdk/python` (`worldmonitor-sdk`), `sdk/go`, `sdk/ruby` (`worldmonitor`), `cli/package.json` (`worldmonitor`); live MCP `get_sources` call on October 16, 2026 |
| Outlets carry an editorial tier, a propaganda-risk band and, where it applies, a state-affiliation label. Readers see them as News panel badges and can look up any outlet with the free `get_sources` MCP tool. [Data sources](/data-sources) explains the scheme but does not list each outlet's labels. | `getPrimarySourceProvenanceBadges` in `src/components/news/source-provenance.ts` (tier badge for tiers 1 and 2, risk badge, provenance facts); live MCP `get_sources` on October 16, 2026 (`outletsByTier` 1 to 4, `outletsByRisk`; the `outlets` view lists each outlet) |
| API-plan chokepoint webhooks deliver a signed `chokepoint.disruption` event when a chokepoint's disruption score crosses the subscriber's threshold. Guides may state this only after the `shipping-webhook-worker` Railway service is provisioned. | `scripts/shipping-webhook-worker.mjs`; `lifecycle` of `shipping-webhook-worker` in `scripts/railway-services.json`; [Shipping v2 API reference](/api-shipping-v2) |
| Live transit counts at every registry chokepoint, with the energy subset measured against an EIA flow baseline | [chokepoint methodology](/methodology/chokepoints); live MCP `get_chokepoint_status` for Hormuz on October 16, 2026 |
| Open source under AGPL-3.0 | `LICENSE` |
| Published self-serve prices | `shared/product-facts.generated.json` plans; guides link to `/pro#pricing` instead of repeating a figure |
| Incident feed: the [incident feed page](/incident-feed) lists the conflict, unrest, news-cluster and event-history endpoints, their fields, filters and retention. Guides link it when they mention the API. | Routes and fields from `proto/worldmonitor/conflict/v1/ucdp_event.proto`, `proto/worldmonitor/unrest/v1/unrest_event.proto`, `proto/worldmonitor/news/v1/news_item.proto`, `proto/worldmonitor/intelligence/v1/intel_history_record.proto`; `get_news_clusters` in `api/mcp/registry/nlp-tools.ts`; live MCP `get_intel_timeline`, `get_conflict_events` and `get_news_clusters` calls on October 17, 2026 |
| Event history is kept for 180 days | `INTEL_HISTORY_RETENTION_DAYS = 180` in `convex/intelHistory.ts`; daily `intel-history-prune` cron in `convex/crons.ts`. The store began filling in 2026: on October 17, 2026 the oldest conflict record (live `get_intel_timeline`) occurred in late July 2026. |
| News clusters carry each outlet's declared tier and a corroboration state (`single-publisher`, `tier4-only`, `corroborated`, `unknown`) | `sourceProvenance[].tier` and `corroboration` in the `get_news_clusters` output schema, `api/mcp/registry/nlp-tools.ts`. MCP only; the REST digest returns headlines with `corroborationCount`, not clusters. |

Limits that guides must state and must not contradict:

| Limit | Proof |
| --- | --- |
| Alerts are scoped by country, not by a radius around an address | `countries` (ISO alpha-2) is the only location scope on alert rules in `convex/schema.ts` |
| Alert rules (Slack, Discord, Telegram, email, browser push, and the notifications webhook) do not carry World Monitor's chokepoint transit or disruption model. Only the API plan's chokepoint webhook does. Guides must not promise chokepoint warnings on alert rules. | The only maritime events are `corridor_risk` (a third-party corridor score of 50 or more for Hormuz, Bab el-Mandeb, Suez, Taiwan Strait and Bosporus, with no Panama mapping) and `shipping_stress` in `scripts/ais-relay.cjs`. Both carry no country, so country-scoped rules drop them (`scripts/notification-relay.cjs`). |
| No Microsoft Teams channel; reaching Teams needs a relay that reposts the signed webhook | Channel list in `convex/schema.ts` |
| No published availability SLA, analyst service, or travel assistance | Not offered in product facts or plans |
| Most providers have not completed a terms review, so guides must not call the sources licensed | Live MCP `get_sources` summary, `providersByStatus` |
| Incident history does not reach back years. Guides must not imply an archive comparable to Factal's 2018 history. News headlines are a live window with no archive: 96 hours by default at build time, plus up to six hours when the last good digest is replayed after a failed rebuild. | `INTEL_HISTORY_RETENTION_DAYS` in `convex/intelHistory.ts`; `resolveMaxAgeMs` in `server/worldmonitor/news/v1/_rss-cache.ts`; `stale_age_seconds` bound in `proto/worldmonitor/news/v1/list_feed_digest.proto` |
| There is no single incident object. A news cluster id changes when an earlier headline joins; webhook payloads carry no event id or coordinates; list routes have no cursor pagination. | `intel_history_record.proto`; `generateClusterId` in `shared/news-clustering-core.js`; `payload` in `scripts/ais-relay.cjs` `rss_alert`; `(sebuf.http.unimplemented)` on `cursor` in `list_ucdp_events.proto` and `list_unrest_events.proto` |
| World Monitor aggregates published reports and does not verify events on the ground | [news credibility methodology](/methodology/news-credibility); `/trust/` labels coverage, not truth |

Guides avoid volatile figures such as prices, tool counts and provider counts. They link to the page that renders the current value.

## Page structure and maintenance

The [reference guide](https://rhinovoice.app/best/dictation-app-for-lawyers) was read as HTML. Its structure is disclosure, short verdict, comparison table, audience criteria, detailed picks, recommendation, practical next steps, questions, and related guides. The implementation retains World Monitor's shared Astro layout, dark theme, green accents, fonts, metadata, and tracked product links.

The content model is one Markdown article per canonical path, grouped under `vs`, `alternatives`, and `best`. The new guide collection reuses the existing article schema and renderer. Guides are discoverable through `/blog/guides/`, the shared navigation, related links, the blog sitemap, and `/blog/llms.txt`.

To review a change, build the blog and run `npm --prefix blog-site run verify:guides`. That gate checks the actual built pages, canonical URLs, structured data, source links, internal links and fragments, and sitemap dates. Browser verification additionally checks mobile overflow and the rendered layout. A build does not verify vendor service quality or production deployment.

Before refreshing a guide, recheck its linked official sources and the current World Monitor access terms. Change its date only after the material review. Preserve disclosure and competitor recommendations where the specialist still fits the task better.
