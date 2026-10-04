---
title: Meter each embedded panel as one bounded user request
date: 2026-10-02
category: performance-issues
module: api/mcp
problem_type: performance_issue
component: service_object
severity: high
root_cause: internal_fanout_charged_as_user_requests
resolution_type: code_fix
tags: [mcp, quota, country-brief, caching, paid-usage]
---

# Embedded-panel usage and cost evidence

The dedicated Pro allowance previously charged each MCP tool call, including
the internal readers needed to render one country brief. A production Pro
connection reached its 50/day ceiling during panel acceptance testing.
Charging the reader graph separately made the allowance unsuitable for normal
country-panel use.

## Decision and bounds

For dedicated paid MCP allowances, `open_country_brief` admits one country
request for one daily unit. Its signed receipt includes the default assessment,
coverage and country section readers. Concurrent opens for the same user,
country and five-minute bucket share an atomic admission, including reuse of
the preceding still-valid bucket. A normal admission
expires in five to ten minutes, clipped at UTC midnight. Explicit refresh uses
a new request ID and a five-minute admission; retrying the same ID does not
charge again or extend the original expiry.

Receipts bind the user, country, environment, window and expiry. Redis must
prove the admission was paid. Current subscription checks remain in place,
including for cached responses. Each admission allows at most 64 uncached
reads. Failed, locked and explicitly unavailable responses remain retryable;
they still consume this work budget. Successful results can be reused until
expiry, with a 512 KiB entry ceiling. Browser caching also has a 4 MiB ceiling.

This preserves progressive panel rendering without introducing a second
server-side country aggregation endpoint. The existing 60 tool calls/minute
burst limit still applies. Rapidly opening and then refreshing a full panel can
hit that temporary limit; grouping daily units does not remove burst protection.
Weighted API-plan billing remains unchanged. There is no quota refund after
admitted work.

## Measured behavior

The built country plugin runs in an opaque iframe against a controlled host.
The fixture includes all ten exposure and dependency sectors, ready sections,
and deliberate locked/unavailable sections. These are browser integration
measurements, not production network latency or a native ChatGPT acceptance
result.

| Action | Host calls | Daily units |
| --- | ---: | ---: |
| Initial country panel | 43 | 1 |
| Repeat the current country and switch topics | 0 | 0 |
| Navigate away and return | 6 | 0 |
| Explicit refresh | 42 | 1 |
| Refresh refused at the daily ceiling | 0 section calls | 0 |

The six calls on return retry deliberately unavailable/locked sections.
Loaded assessment, coverage and ready sections are reused. The controlled
initial render took 808 ms in the final recorded run; fixture scheduling and local
rendering dominate this timing. Applying the previous one-unit-per-call rule
to the same 43 calls would consume 43 units. That comparison is calculated,
not an observed run of the previous implementation.

The handler suite separately proves that the full reader graph, including ten
exposure/dependency pairs, stays within one daily charge. It also proves
concurrent admission, replay at the daily ceiling, explicit-refresh charging,
scope and signature rejection, entitlement revocation, unchanged API billing,
failed-response retries, and HTTP 429 with `Retry-After` at the read ceiling.
Lua tests execute the real admission and read-budget scripts and verify the
Redis proxy's script allowlist matches them byte for byte.

## Allowance decision

Retain Pro's 50 and Pro Business's 250 daily units provisionally. The unit now
matches a country request instead of its internal fan-out. As an assumed daily
usage scenario, ten country opens, ten explicit refreshes and twenty standalone
tools cost 40 units. This is a planning example, not measured customer behavior.

At the hard work ceiling, 50 country admissions permit at most 3,200 uncached
reads/day, and 250 permit 16,000. Cached results and scope checks reduce actual
upstream work. Before raising these allowances, measure upstream requests,
provider invoices, compute duration and storage traffic for representative
production use. No cloud dollar cost or customer daily-usage distribution was
available for this change, so it does not claim that either numeric limit is
economically calibrated.

The panel displays the remaining daily allowance and UTC reset time from its
last admission. It identifies included section loads and the one-unit cost of
refresh. Usage elsewhere can change after that observation; the notice is not
a live account-wide polling view.

## Repeat the verification

Use Node.js 24 and the repository's test preflight. Run:

```sh
node --import tsx --test tests/mcp-panel-metering.test.mjs tests/mcp-quota-reserve-script.test.mjs tests/country-brief-host-transport.test.mts
npx vite build --config vite.plugin.config.ts
npx playwright test e2e/plugin-country-view.spec.ts --project=chromium
```

The browser test attaches `country-request-cost.json` plus desktop/mobile
screenshots. After deployment, test a real paid ChatGPT connection for country
open, topic changes, return navigation, refresh, daily-cap denial and reset
notices. Local handler/browser proof does not establish deployment, live data
freshness or store readiness. The change requires no data migration; rollback
must revert both the server admission behavior and the panel receipt/cache UI.

## All-panel audit and news/dashboard extension

The rule applies to all twelve embedded views. The billing matrix exercises
all registered roots through the real MCP handler and verifies that reading
the visual shell adds no charge. Its missing-data fixtures also preserve the
no-refund behavior after upstream work. Ten static bridges render the tool
result and make no further data calls; their DOM tests verify usage notices
and the absence of tools/call messages. Country and news are composite views.

| Embedded view | Root tool | Daily units per opening | Included data |
|---|---|---|---|
| Country risk | get_country_risk | 1 | Risk result and component details |
| World brief | get_world_brief | 1 | Brief and source details |
| Country text brief | get_country_brief | 1 | Text assessment and evidence |
| Markets | get_market_data | 1 | Selected market result |
| Chokepoints | get_chokepoint_status | 1 | Status and route details |
| News intelligence | get_news_intelligence | 1 | Selected intelligence result |
| Conflicts | get_conflict_events | 1 | Selected conflict result |
| Natural disasters | get_natural_disasters | 1 | Selected hazard result |
| Prediction markets | get_prediction_markets | 1 | Selected markets |
| Forecasts | get_forecast_predictions | 1 | Forecast result |
| Country view | open_country_brief | 1 | Default assessment, coverage and section graph |
| News and maps | open_news_dashboard | 1 | News panels and bounded hazard snapshots |

A news admission shares the same atomic reservation, owner-bound signature,
UTC expiry and 64-uncached-read ceiling as the country admission. It permits
only the full digest and reviewed hazard datasets at limits 100, 20 or 1.
It cannot fund country data, arbitrary tools or AI summaries. The root digest
cache permits at most 1 MiB; other admitted results permit 512 KiB. Partial,
stale and failed results are retried. A rendered dashboard reuses successful
hazard selections without host calls and coalesces simultaneous refreshes.
Host input does not trigger hazard calls before the paid result arrives.

The built opaque-iframe browser test measured two initial host calls (open
plus natural hazards) for one daily unit. Layer toggles replayed loaded data
with zero calls. Adding fire data made one internal call and spent zero extra
units. Refresh made two host calls for one new daily unit; denied refresh
started no hazard calls and retained the news. These are controlled fixtures,
not measured production costs or native ChatGPT acceptance.

Re-run `tests/mcp-panel-usage-ui.test.mts` and
`e2e/plugin-news-metering.spec.ts` with the existing tests above. After deployment,
repeat news/map open, layer toggles, filters, refresh and denial in ChatGPT.
A user-triggered news summary or translation is a separate request. API-plan
weighted metering is unchanged.
