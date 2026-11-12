# SEO and AI-citation visibility scorecard

This directory is the inspectable measurement artifact for issue #5667. It keeps
traditional search, AI answers, referrals, and product outcomes separate so a
missing source cannot silently become a zero or a site-wide vanity score.

## Files

- `query-set.json` — 25 reviewed decision queries with intent, audience, target
  page, conversion goal, and named comparison/source entities.
- `baselines/<date>.json` — normalized source availability, search/referral
  windows, manual AI observations, the exact query-contract digest,
  reproduction context, and the prioritized opportunity queue.
- `scorecards/<date>.md` — deterministic human report generated from a baseline.
- `scripts/seo-ai-visibility-collector.mjs` — secure local importer for bounded
  first-party exports; it emits only the normalized baseline contract.
- `scripts/seo-ai-visibility-scorecard.mjs` — validator, scorecard renderer, and
  monthly comparison.
- `gsc/<date>.json` and `gsc/<date>.md` — Search Console snapshots produced by
  `scripts/seo-gsc-collect.mjs`, which reads the API rather than a UI export.
  See `gsc/README.md`. Its per-family rows feed
  `sources.googleSearchConsole` here rather than starting a parallel report.
- `bing/<date>.json` and `umami/<date>.json` — Bing Webmaster and Umami
  referral snapshots from `scripts/seo-bing-collect.mjs` and
  `scripts/seo-umami-collect.mjs`, written by the same weekly run when their
  credentials are configured.
- `answerrank/<date>.json` and `answerrank/<date>.md` — weekly AI-answer
  snapshots from `scripts/seo-answerrank-collect.mjs`: how often model API
  answers to 13 fixed buyer questions name or cite World Monitor, and whether
  that changed significantly since the last comparable week. They are a proxy,
  not observations of the AI products, so they never fill `aiSurfaces`. See
  `answerrank/README.md`.
- `scripts/seo-weekly-baseline.mjs` — turns one date's snapshots into
  `baselines/<date>.json` and `scorecards/<date>.md`. See
  [Weekly regeneration](#weekly-regeneration).
- `tests/seo-weekly-baseline.test.mjs` — fixture-backed mapping, missingness
  and determinism coverage for that step.
- `tests/seo-ai-visibility-collector.test.mjs` and
  `tests/seo-ai-visibility-scorecard.test.mjs` — importer, schema, missingness,
  aggregation, comparison, and reproducibility coverage.

The committed initial period is `2026-07-27`. It uses baseline contract v1 and
contains a four-platform manual observation for `q01`. Search Console, Bing
Webmaster, and referral values are explicitly unavailable because the clean
worktree had no property access or supported exports. That is an incomplete
data source, not zero demand.

Committed source `property` fields must remain `null`; property identifiers and
credentials belong only in secure operator configuration. `aiSurfaces` records
whether each requested surface was available, partial, or unavailable, with a
reason for any non-available state. `aiObservations` contains only
query/platform pairs that were actually inspected.

Baseline contract v1 is the historical four-surface contract. Its identifiers
are `chatgpt_search`, `perplexity`, `google_ai`, and `copilot_search`, for a full
target of 25 × 4 = 100 query/surface pairs. Keep `google_ai` and its recorded
Google AI Overview label unchanged in historical files.

Baseline contract v2 is the five-surface contract for new cycles. Its
identifiers are `chatgpt_search`, `perplexity`, `google_ai_overview`,
`google_ai_mode`, and `copilot_search`, for a full target of 25 × 5 = 125 pairs.
Do not use legacy `google_ai` in a v2 baseline. Overview and Mode are separate
observations even when they answer the same query in the same cycle.

## Reproduce the current scorecard

From a clean repository checkout:

```bash
node scripts/seo-ai-visibility-scorecard.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --baseline docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --output docs/research/seo-ai-visibility/scorecards/2026-07-27.md \
  --check
```

Later baselines and scorecards are regenerated every week from the API
snapshots; see [Weekly regeneration](#weekly-regeneration). To produce one by
hand under the same baseline contract, copy the prior
baseline to a new dated file, replace only observations and supported-export
values, then omit `--check` and point `--output` at the new date. Do not edit an
older observation in place. Start the first v2 cycle through the collector with
`schemaVersion: 2`; do not relabel a historical v1 observation. The copied
`querySetDigest` pins the exact query text, intent, target, conversion, and
reference-entity contract used by the period.

If any comparison-critical query field changes, assign a new `querySetId` and
start a new baseline series with the digest computed by
`computeQuerySetDigest()` in the scorecard module. Existing baselines must keep
their original ID and digest; the validator rejects silently reinterpreting
historical observations with a newer query definition.

## First-party collection and secure import

`scripts/seo-ai-visibility-collector.mjs` turns a local source manifest into a
dated baseline. It does not authenticate to providers, scrape result pages, or
write raw exports. Operators should obtain read-only exports through the
provider UI/API, keep credentials and raw files outside the repository, and
pass only the bounded manifest to the collector:

```bash
node scripts/seo-ai-visibility-collector.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --template docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --sources "$SEO_VISIBILITY_SOURCE_MANIFEST" \
  --observed-at "$SEO_VISIBILITY_OBSERVED_AT" \
  --output "$SEO_VISIBILITY_RUN_DIR/baseline.json"
```

The manifest is intentionally narrow:

- `schemaVersion` selects the baseline contract. Omit it only when reproducing
  a v1 template. Set it to `2` for every new five-surface cycle.
- `googleSearchConsole` and `bingWebmaster.search` contain trailing `28d` and
  `90d` windows with aggregate metrics, exact reviewed `query`/`queryId` rows,
  and `page`/`pageFamily` rows. Query text must exactly match `query-set.json`;
  unknown queries and page families fail closed. The normalized artifact drops
  property IDs and tokens.
- `bingWebmaster.aiPerformance` contains the same two windows plus provider-
  reported `totalCitations`, `averageCitedPages`, `groundingQueries`, and
  `citedPages`. Cited pages must be HTTPS `worldmonitor.app` URLs. Citation
  totals describe observed source usage, not ranking or authority.
- `referrals` contains bounded aggregate `metrics` or event `rows` grouped only
  by the reviewed `referrerFamily` and `landingPageFamily`. Supported events are
  sessions, dashboard launches, pricing views, sign-ups, checkout success,
  completed `pro-activation-exit`, successful API-key actions, and successful
  MCP connections. Attempt events are not counted as successful outcomes.
- `collectionContext`, `aiSurfaces`, and `aiObservations` are copied through a
  whitelist. Unknown provider fields and raw prompt, account/session, key, and
  user-level payload fields are never written to the baseline; keep personal
  prompt content out of the reviewed summary fields as well.

For a v2 cycle, `aiSurfaces` is required and must contain every v2 identifier
exactly once. Use `available`, `partial` with a reason, or `unavailable` with a
reason based on the actual collection result. The collector does not infer one
Google experience from the other. A minimal manifest can start with all five
surfaces explicitly unavailable and no observations:

```json
{
  "schemaVersion": 2,
  "aiSurfaces": [
    { "platform": "chatgpt_search", "status": "unavailable", "reason": "Record the actual reason." },
    { "platform": "perplexity", "status": "unavailable", "reason": "Record the actual reason." },
    { "platform": "google_ai_overview", "status": "unavailable", "reason": "Record the actual reason." },
    { "platform": "google_ai_mode", "status": "unavailable", "reason": "Record the actual reason." },
    { "platform": "copilot_search", "status": "unavailable", "reason": "Record the actual reason." }
  ],
  "aiObservations": []
}
```

Add an observation only after that exact surface was inspected. Each observation
requires `queryId`, the v2 `platform` identifier, `observedAt`, `geography`,
`locale`, `signedInState`, `brandMention`, `directCitation`, `citedUrls`,
`competitorsCited`, `sentiment`, `accuracy`, `summary`, and `limitations`.
`geography`, `locale`, and `signedInState` must match the declared
`collectionContext`. Extra fields such as raw prompts, account/session IDs,
tokens, property IDs, and provider payload extensions are discarded.

For every source, use `status: "partial"` when only some windows/metrics are
supported and `status: "unavailable"` with a reason when access is missing.
The collector preserves provider-reported zeroes and emits `null` for omitted
metrics. It requires two trailing windows for search and Bing AI Performance;
missing referral dimensions remain partial rather than being inferred. Validate
the generated file before rendering the report:

```bash
node scripts/seo-ai-visibility-collector.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --template docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --sources "$SEO_VISIBILITY_SOURCE_MANIFEST" \
  --observed-at "$SEO_VISIBILITY_OBSERVED_AT" \
  --output "$SEO_VISIBILITY_RUN_DIR/baseline.json" \
  --check
```

## Weekly collection

`.github/workflows/seo-gsc-weekly.yml` collects sections 1, 2 and 4 from the
provider APIs every Tuesday and regenerates the baseline and scorecard from
them (see [Weekly regeneration](#weekly-regeneration)). Nobody exports or
transcribes anything. The steps below describe what each source must supply,
and apply by hand only when a baseline is built outside that workflow.

### 1. Search Console

`scripts/seo-gsc-collect.mjs --live` reads the Search Analytics and URL
Inspection APIs into `gsc/<date>.json`. Do not scrape Google result pages.

For both the trailing 28-day and 90-day windows:

1. Export search performance grouped by query and page, retaining clicks,
   impressions, CTR, and average position.
2. Export or record the supported Page Indexing summary for indexed pages.
3. Look up each reviewed query in `query-set.json` with an exact-match filter
   on the query dimension, and record the set's id and digest with the results.
4. Group target pages into the `targetPage.family` values the query set
   declares for its schema version. `scripts/lib/seo-url-taxonomy.mjs` performs
   that mapping for any site URL and refuses an unmapped one.
5. Put site aggregates in `search.googleSearchConsole.windows`, reviewed-query
   rows in `queryRows` (`windowLabel`, `queryId`, performance metrics), and
   bounded page-family rows in `pageFamilyRows` (`windowLabel`, `pageFamily`,
   indexation and performance metrics).
6. Preserve the source export beside the operator's secure working files, not
   in this repo.

If the export or indexing view is unavailable, keep every metric `null`, set
`status` to `partial` or `unavailable`, and explain the missing source in
`reason`. An unavailable provider has empty `queryRows` and `pageFamilyRows`.
A partial provider may retain supported finite values while unavailable metrics
remain `null`. A zero is valid only when the provider explicitly reported zero.
A query row with no metrics must carry a `reason`, and the query-intent slice
shows how many of its queries were reported instead of a partial sum.
Every provider window must end on or before the baseline's `observedAt` date.

### 2. Bing Webmaster

`scripts/seo-bing-collect.mjs --live` reads the Bing Webmaster API into
`bing/<date>.json` when `BING_WEBMASTER_API_KEY` is configured. Its totals come
from daily site rows; its query and page sums are top-100-per-week, so the
baseline marks Bing partial. Bing AI Performance has no API method and stays
unavailable. IndexNow submission is not evidence of indexing, impressions,
clicks, or rank.

### 3. Manual AI-answer panel

The panel was dropped on 2026-11-02 (#10024) and nothing automated replaces
it, so weekly baselines record every surface as unavailable with that reason
and carry no observations. AI referral traffic is tracked in the Umami referral
snapshot instead. The instructions below describe how the historical
observations were made.

Run the exact query text without paraphrasing. New v2 cycles use a target matrix
of 25 queries by five surfaces:

- ChatGPT Search
- Perplexity
- Google AI Overview
- Google AI Mode
- Copilot Search

For each observation record:

- UTC date/time, country-level geography, locale, device, and signed-in state;
- brand mention;
- direct citation only when a visible answer link resolves to a
  `worldmonitor.app` host;
- all visible cited URLs and competitors cited;
- sentiment and an accuracy judgment;
- platform limitations, personalization, and any claim that needs correction.

Each observation timestamp must be at or before the baseline's `observedAt`
snapshot. Move the baseline timestamp forward when later evidence is added
instead of backdating that evidence into an earlier scorecard.

Do not save account identifiers, precise location, unrelated history, personal
prompts, or hidden/collapsed data that was not actually inspected. If a platform
is unavailable, set its `aiSurfaces` status and reason and omit fabricated
observations. Do not substitute another surface while labeling it as the
requested one.

### 4. Referral and outcome reconciliation

The weekly snapshot workflow collects referral aggregates automatically.
`scripts/seo-umami-collect.mjs --live` reads Umami visitors by channel and by
referrer domain for the 28 complete UTC days before the run. It writes
`umami/<date>.json` and a markdown summary, mapping each domain onto the
referrer families above plus search, social, internal and other.
`google_search_ai` stays unavailable: AI Overviews and AI Mode send the same
google.com referrer as web search. Only `sessions` reaches the baseline from
it, as Umami visits; the outcome fields below have no automated source yet and
stay `null`.

Use read-only aggregate exports from the existing analytics and commerce
providers. Keep dimensions bounded to referrer family, landing-page family,
reviewed topic/query cluster, and conversion step. Do not collect prompt text.

The normalized outcome fields are:

| Field | Current evidence seam |
| --- | --- |
| `sessions` | Referrer/UTM-attributed analytics sessions |
| `dashboardLaunches` | Canonical homepage/dashboard landing pageviews |
| `pricingViews` | `/pro` pricing pageviews |
| `signUps` | `sign-up` |
| `proConversions` | `checkout-success`, reconciled to aggregate commerce totals |
| `activations` | Completed `pro-activation-exit` events only |
| `apiActions` | Successful, bounded API-key lifecycle actions when available |
| `mcpActions` | `mcp-connect-success` only; attempts remain separate telemetry |

Put aggregate totals in `referrals.windows`. Put bounded cross-sections in
`referrals.segments`, keyed by `windowLabel`, `referrerFamily`, and
`landingPageFamily`. Each segment carries the same normalized outcome metrics,
which lets the report connect acquisition source to a product handoff without
storing a prompt or user-level event.

The blog's `blog-product-cta-click` event supplies bounded article,
destination, and placement context. Preserve inbound UTM attribution. Never use
`ref=` for internal SEO/AI source tags: the dashboard treats it as an affiliate
referral code.

## Weekly regeneration

After the collectors run, the weekly workflow calls:

```bash
node scripts/seo-weekly-baseline.mjs --date "$(date -u +%F)"
```

It reads `gsc/<date>.json` (required) and `bing/<date>.json` and
`umami/<date>.json` (each optional), builds the source manifest, runs it
through `collectBaseline`, and writes `baselines/<date>.json` and
`scorecards/<date>.md`. The scorecard is compared with the newest baseline dated
before `<date>`, which is also the template: the query contract, referral
classification, opportunity queue, guardrails and declared collection context
carry forward, so consecutive weeks stay comparable. The template's limitations
do not; each run states its own. Nothing is written unless both files build,
and the step is `continue-on-error`, so a failure leaves the snapshots to ship
alone with a note in the PR body. The opportunity queue is human-reviewed:
edit it in the newest baseline when it no longer fits, and the next week
carries the edit forward.

Each collector owns the mapping from its own snapshot, and
`seo-ai-visibility-collector.mjs` stays the only normalizer. A value is copied
only where its meaning matches the contract field:

| Baseline field | Source | When it is `null` |
| --- | --- | --- |
| Search Console window clicks, impressions, CTR, position | `performance.windows[].siteTotals.all` (by property) | No by-property totals for that window. The page-row sum is never used: it counts one search once per URL shown. |
| Search Console window `indexedPages` | `indexation.htmlPages.indexed`, the same count in both windows | The inspection sample did not cover every declared URL. |
| Search Console page-family rows | `performance.windows[].byFamily` (page-grouped); `indexedPages` from `htmlPages.indexedByFamily` | A family's URLs were not all inspected. A family with no page row in a truncated window gets no row. |
| Search Console query rows | `reviewedQueries.windows[].lookups`, one per reviewed query and window | Google returned no row (`not-reported`: below its privacy threshold or no impressions) or the lookup failed (`unavailable`). Each row keeps null metrics and its `reason`; neither is a zero. There are no rows when the snapshot predates the lookups or they were made for a different query set (`querySetId` and `querySetDigest` differ); the source `reason` says which. |
| Bing window clicks, impressions, CTR | `traffic.windows` (daily site rows) | Bing reported fewer days than the window has. |
| Bing window and page-family position | none | Always: the daily rows carry no position. |
| Bing `indexedPages` | `crawl.latest.inIndex` | Crawl stats unavailable. Page-family rows never carry one. |
| Bing query and page-family rows | `queries`/`pages` top-100-per-week sums | The source is always `partial` and says so. |
| Bing AI Performance | none | Always unavailable, with the snapshot's reason: no API method. |
| Referral `sessions` (28d) | Umami `totals.visits`, summed over 28 one-day queries | Umami totals were missing a day or unavailable. Visitors are visitor-days and are never reported as sessions. |
| Other referral outcome metrics, the 90d window, segments | none | Always: no landing-page or event breakdown is collected, and Umami keeps 30 days. Referrer-family visitor-days are listed in the reason instead. |
| `aiSurfaces`, `aiObservations` | none | Every surface unavailable; no observations. |

A source with no snapshot for the date is `unavailable` with a reason naming
the missing credential or failed collection. Bing windows end on the latest
date Bing reports, so when that date has not moved past the previous
baseline's, Bing is `unavailable` for the week with that reason, rather than
failing the comparison; the snapshot itself still ships in `bing/`.

## Monthly comparison

The weekly step above runs this comparison automatically. To generate a
scorecard by hand, pass the previous normalized baseline:

```bash
node scripts/seo-ai-visibility-scorecard.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --previous docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --baseline docs/research/seo-ai-visibility/baselines/2026-08-27.json \
  --output docs/research/seo-ai-visibility/scorecards/2026-08-27.md
```

The comparison reports:

- the platform coverage in each period, including surfaces that exist in only
  one contract or are unavailable in either period;
- new and lost direct citations only when the same exact query, platform,
  geography, locale, and signed-in context was observed in both periods and its
  citation state changed;
- newly observed and no-longer-observed query/platform/context combinations
  separately, so sparse audit coverage cannot masquerade as citation gain or
  loss;
- meaningful impression, click, CTR, average-position, and indexed-page changes
  when both periods have supported provider data and the current provider
  window's start and end dates both advance beyond the previous window;
- referral/outcome movement when both periods are available;
- mixed or inaccurate entity answers that need correction;
- the current evidence-backed experiment queue.

The comparison rejects reversed periods, same/backward provider windows, a
changed query-set ID or digest, or a changed collection geography, locale,
device, or signed-in schedule. The report prints the exact previous/current
provider date ranges beside meaningful deltas. Change comparison dimensions by
starting a new baseline series instead of presenting incomparable audits as
month-over-month movement.

For a v1-to-v2 comparison, legacy `google_ai` is comparable only with
`google_ai_overview`, which preserves its recorded Google AI Overview meaning.
It is never treated as an AI Mode observation. `google_ai_mode` observations are
reported as not comparable until both periods use that independently measured
surface. Like-for-like v2 periods can then report real AI Mode citation gains or
losses.

Thresholds are diagnostics, not causal claims. A single answer, citation, or
traffic change never proves uplift. Sparse observations, a missing provider, or
a citation-only change cannot be presented as causal traffic, sign-up,
conversion, activation, API, or MCP uplift.

## Secure configuration

No credential or property identifier belongs in this directory. Future API
collectors must read secrets from ignored local environment state or the
deployment secret store, request read-only scopes, and write only normalized,
reviewed aggregates. Do not commit raw account exports when they contain user,
query, or property data outside this reviewed measurement contract.

## Expansion gate

Do not add a content/page family solely because a vendor score or one AI answer
suggests it. Expansion requires all four:

1. evidence of search or customer demand;
2. healthy indexation;
3. useful engagement rather than undifferentiated traffic;
4. a credible dashboard, pricing, API, or MCP handoff.
