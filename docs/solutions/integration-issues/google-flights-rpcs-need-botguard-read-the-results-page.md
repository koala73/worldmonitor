---
title: Google Flights RPCs now need a BotGuard token; the server-rendered results page still carries the same payload
date: 2026-10-17
category: integration-issues
module: ais-relay google flights
problem_type: integration_issue
component: background_job
symptoms:
  - "search_flights and search_flight_prices_by_date return {\"flights\":[],\"degraded\":true,\"error\":\"relay returned 502\"}"
  - "GetShoppingResults and GetCalendarGraph answer with RPC status 13 instead of itineraries"
  - "The Airline Intel prices tab shows no fares for any route"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - mcp search_flights
  - mcp search_flight_prices_by_date
  - AirlineIntelPanel
tags: [google-flights, botguard, tfs, protobuf, af-initdatacallback, ais-relay, scraper, mcp]
---

# Google Flights RPCs now need a BotGuard token; the server-rendered results page still carries the same payload

## Problem

The relay's Google Flights handlers called Google's internal RPCs (`GetShoppingResults` for itineraries, `GetCalendarGraph` for the date grid). Google started requiring a BotGuard token on those calls, so every search failed. Both MCP flight tools and the Airline Intel panel returned empty, degraded results.

## Symptoms

- MCP tools returned `{"flights":[],"degraded":true,"error":"relay returned 502"}`.
- The RPC responses carried status 13 with no payload.

## What Didn't Work

- Retrying or changing headers on the RPCs. The token is computed by Google's in-page JavaScript; a server cannot mint it without running that script.

## Solution

Read the server-rendered results page instead (PR #9204). `https://www.google.com/travel/flights/search?tfs=…&hl=en&gl=us&curr=USD`, fetched with a Chrome User-Agent and `Cookie: CONSENT=YES+` (`GF_HEADERS` in `scripts/ais-relay.cjs`), still answers from Railway. Probes from the ais-relay container took about 1.4 s per page, and 31 pages at six in flight finished in 9.6 s without throttling.

The page embeds the same payload the RPC returned, in an `AF_initDataCallback({key: 'ds:1', hash: '…', data:…, sideChannel: {}})` block. `data[2][0]` holds the best flights and `data[3][0]` the rest, so the existing item parser was reused unchanged. `readGfPayload` handles three page shapes:

- **Results:** parse the JSON between `data:` and the last `, sideChannel:`.
- **Rejected search** (for example a past date): the block has no `hash` and ends `data:[3,null,[["…ErrorResponse",…]]],errorHasStatus: true,});`. Treat it as a provider failure, not as zero flights.
- **No service** on the route: `data[2]` and `data[3]` are null, a genuine empty result.

The search is encoded in `tfs`, a base64url protobuf (field numbers follow the fast-flights project; `buildGfSearchUrl`):

| Field | Meaning |
|---|---|
| 3 | one leg message per direction |
| 8 | one entry per adult |
| 9 | cabin: 1 economy, 2 premium, 3 business, 4 first |
| 19 | trip: 1 round, 2 one-way |
| leg 2 | date |
| leg 5 | max stops as the count itself (0, 1, 2); omit for any |
| leg 6 | airline code, repeated |
| leg 13 / 14 | origin / destination airport message, code in its field 2 |

Cabin, airlines, adults (prices double) and round trip were each verified live.

The date grid has no page equivalent of `GetCalendarGraph`, so it reads one results page per day and keeps the cheapest fare. That costs one fetch per day, so the range dropped from 366 days to 31 (`GF_DATES_MAX_DAYS`), with six pages in flight per search and eight relay-wide (`GF_PAGE_SLOTS`).

## Why This Works

BotGuard guards the XHR endpoints the page's JavaScript calls after load. The first HTML response is rendered on the server and already contains the initial results, so a plain GET gets the data without running any script.

## Prevention

- Keep the captured fixtures in `tests/fixtures/google-flights/` (results, no service, rejected search) and the synthetic `resultsPage` builder in `tests/helpers/google-flights-page.mts`. Parser tests run against real page bytes.
- A round-trip page lists only the outbound legs, and prices are round-trip totals. A departure-time window can only filter the outbound departure; `tfs` has no time field.
- When an upstream starts answering with an empty or error shape, distinguish "provider rejected" from "no results" before reporting zero. Report the first as degraded.

## Related Issues

- PR #9204 (results-page rewrite), PR #9212 (field-level validation errors for the same tools).
- [Barchart WAF challenge answers HTTP 202 and passes resp.ok](barchart-waf-challenge-answers-202-and-passes-resp-ok.md): another scraper upstream that changed shape without an HTTP error.
