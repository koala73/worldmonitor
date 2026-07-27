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
- `scripts/seo-ai-visibility-scorecard.mjs` — validator, scorecard renderer, and
  monthly comparison.
- `tests/seo-ai-visibility-scorecard.test.mjs` — schema, missingness, aggregation,
  comparison, and reproducibility coverage.

The committed initial period is `2026-07-27`. It contains a four-platform manual
observation for `q01`. Search Console, Bing Webmaster, and referral values are
explicitly unavailable because the clean worktree had no property access or
supported exports. That is an incomplete data source, not zero demand.

Committed source `property` fields must remain `null`; property identifiers and
credentials belong only in secure operator configuration. `aiSurfaces` records
whether each requested surface was available, partial, or unavailable, with a
reason for any non-available state. `aiObservations` contains only
query/platform pairs that were actually inspected.

## Reproduce the current scorecard

From a clean repository checkout:

```bash
node scripts/seo-ai-visibility-scorecard.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --baseline docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --output docs/research/seo-ai-visibility/scorecards/2026-07-27.md \
  --check
```

To generate a later scorecard, copy the prior baseline to a new dated file,
replace only observations and supported-export values, then omit `--check` and
point `--output` at the new date. Do not edit an older observation in place.
The copied `querySetDigest` pins the exact query text, intent, target, conversion,
and reference-entity contract used by the period.

If any comparison-critical query field changes, assign a new `querySetId` and
start a new baseline series with the digest computed by
`computeQuerySetDigest()` in the scorecard module. Existing baselines must keep
their original ID and digest; the validator rejects silently reinterpreting
historical observations with a newer query definition.

## Weekly collection

### 1. Search Console

Use the Search Console UI export or Search Analytics API. Do not scrape Google
result pages.

For both the trailing 28-day and 90-day windows:

1. Export search performance grouped by query and page, retaining clicks,
   impressions, CTR, and average position.
2. Export or record the supported Page Indexing summary for indexed pages.
3. Join reviewed query rows to `query-set.json` by the exact query text.
4. Group target pages into the ten `targetPage.family` values in the query set.
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
Every provider window must end on or before the baseline's `observedAt` date.

### 2. Bing Webmaster

Where property access exists, export query/page performance and indexation using
Bing Webmaster's supported UI/API. Normalize the same metric names and periods
under `search.bingWebmaster`. IndexNow submission is not evidence of indexing,
impressions, clicks, or rank.

### 3. Manual AI-answer panel

Run the exact query text without paraphrasing. The target matrix is 25 queries
by four surfaces:

- ChatGPT Search
- Perplexity
- Google AI Overview/AI Mode where available
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
| `apiActions` | Bounded API-reference/key-management actions when available |
| `mcpActions` | `mcp-connect-attempt` / `mcp-connect-success` |

Put aggregate totals in `referrals.windows`. Put bounded cross-sections in
`referrals.segments`, keyed by `windowLabel`, `referrerFamily`, and
`landingPageFamily`. Each segment carries the same normalized outcome metrics,
which lets the report connect acquisition source to a product handoff without
storing a prompt or user-level event.

The blog's `blog-product-cta-click` event supplies bounded article,
destination, and placement context. Preserve inbound UTM attribution. Never use
`ref=` for internal SEO/AI source tags: the dashboard treats it as an affiliate
referral code.

## Monthly comparison

Generate the current scorecard with the previous normalized baseline:

```bash
node scripts/seo-ai-visibility-scorecard.mjs \
  --queries docs/research/seo-ai-visibility/query-set.json \
  --previous docs/research/seo-ai-visibility/baselines/2026-07-27.json \
  --baseline docs/research/seo-ai-visibility/baselines/2026-08-27.json \
  --output docs/research/seo-ai-visibility/scorecards/2026-08-27.md
```

The comparison reports:

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

Thresholds are diagnostics, not causal claims. A single answer, citation, or
traffic change never proves uplift.

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
