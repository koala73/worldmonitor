---
title: "Widget agent data fetches 401'd for months, and the model quietly fell back to web search"
date: 2026-09-29
category: integration-issues
module: widget-builder
problem_type: integration_issue
component: assistant
severity: high
symptoms:
  - "\"gold vs silver 30 days chart\" in the Pro Widget Builder showed `Fetching search:gold silver price daily last 30 days 2025…` instead of reading WorldMonitor market data"
  - "Axiom `wm_api_usage` rows with `user_agent == 'WorldMonitor-WidgetAgent/1.0'`: 271 of 296 since 2026-06-07 were `401 auth_401`"
  - "Only `list-acled-events` ever returned 200 to the agent, and it stopped on 2026-09-02"
  - "No error surfaced anywhere: widgets still rendered, built from web snippets"
root_cause: missing_permission
resolution_type: code_fix
related_components: [authentication, testing_framework]
tags: [widget-agent, ais-relay, wm-session, anonymous-session, 401, web-search, llm-tool-routing, relay-key, enterprise-key, axiom]
---

# Widget agent data fetches 401'd for months, and the model quietly fell back to web search

## Problem

The widget builder's `fetch_worldmonitor_data` tool, in `handleWidgetAgentRequest` in `scripts/ais-relay.cjs`, called `https://api.worldmonitor.app` with only a `User-Agent`. After the #3541 hardening removed Origin trust, `validateApiKey` in `api/_api-key.js` answers any request without a credential with `401 {"error":"API key required"}`. The tool description tells the model to treat errors as unavailable data, so on every data request it reached for `search_web`. Widgets kept rendering, built from web snippets with search queries dated a year back.

## Symptoms

- The builder showed `Fetching search:…` first on requests that WorldMonitor data covers (commodities, indices, FX, quakes, gas storage).
- Search queries named past years ("… 2025"), because the system prompt has no date in it.
- Production telemetry held the whole story, but nobody was reading it: `['wm_api_usage'] | where user_agent contains 'WidgetAgent' | summarize n=count() by status, reason, route`.
- `tests/widget-builder.test.mjs` mocks `fetch`, and one contract test even treats a 401 body as a normal tool result, so CI was green throughout.

## What Didn't Work

- **Reading the prompt as the cause.** Both system prompts already say to prefer a bootstrap key, then an RPC, and to use search only for gaps. A prompt-only fix would have changed nothing, because the model was following those rules on top of failing data.
- **Sending `WORLDMONITOR_RELAY_KEY`.** It looked like the natural internal credential, so the first revision of #8720 sent it and taught `validateApiKey` to accept it as an anonymous session. An adversarial review then found that the production relay key is **also one of the `WORLDMONITOR_VALID_KEYS` enterprise keys** (compared on the Railway `ais-relay` service without printing values). `.env.example` had told operators to reuse an enterprise value. `validateCredential` checks enterprise keys first. So model-chosen endpoints would have skipped entitlement checks and the direct-LLM quota. For example, a widget prompt could have run `get-country-intel-brief` without limit. The revision was replaced before merge.
- **Invalidating the cached session on every 401.** Pro-only routes also answer 401 to an anonymous session. With this rule, each time the model chose a Pro route the relay minted a new session, spending the fail-closed 30/min per-IP issuance limit (`SESSION_RATE_LIMIT_PER_MINUTE` in `api/wm-session.js`). This repeats the sibling mistake in [one-route-401-declared-the-whole-anon-session-dead](../logic-errors/one-route-401-declared-the-whole-anon-session-dead.md).

## Solution

#8720: the relay mints the same credential a browser visitor gets, and never anything stronger.

- `getWidgetDataSessionToken` (`scripts/ais-relay.cjs`) calls `POST https://api.worldmonitor.app/api/wm-session`. That endpoint answers a server-side caller with no Origin. The relay keeps the `wms_` token until five minutes before its `exp` (12 h TTL), shares one in-flight mint between callers, and rejects any response that isn't a `wms_` token.
- The data fetch sends the token as `X-WorldMonitor-Key`, with `redirect: 'error'`. `/api/download` answers 302 to GitHub, and undici forwards custom headers across origins.
- `invalidateWidgetDataSession` runs only when the 401 body says `Invalid session token`. A Pro-route denial reads `Pro authentication required` and leaves the session alone. Both bodies were checked live.
- If minting fails, the fetch goes out without a credential and the model gets the 401 text, the same as before.

Live authority check with a minted session: `bootstrap?keys=commodityQuotes`, `get-gold-intelligence` and `get-fred-series?series_id=UNRATE` return 200. `get-country-intel-brief` and `analyze-stock` return 401.

## Why This Works

The endpoints are chosen by the model, so whatever the relay sends gives a prompt that much authority. An anonymous `wms_` session is exactly anonymous authority. Anyone can mint one, `forceKey` routes reject it, and the gateway still runs entitlement checks. Fixing the credential, rather than the prompt, fixed the routing. A probe with 25 prompts × 2 on the PRO model (real model, live API, stubbed search) cut the share of runs that searched from 86% to 22%. An enterprise key gave 20%, so staying anonymous costs almost nothing. The remaining searches are real data gaps (weather, sports, retail prices) and "latest" follow-ups.

Verified in production on 2026-09-29, after `ais-relay` deployed the merge commit. Axiom shows the relay's `/api/wm-session` 200 (egress Ashburn). FRED calls return 400, not 401, so they pass auth and fail only on the series ID. Three real `/api/widget-agent` runs went to `bootstrap` first with no search, and their widgets carry WorldMonitor prices (GC=F $4,187.70 against a live bootstrap reading of $4,192 minutes later).

## Prevention

- **Check the fetch status mix before touching agent prompts.** When an LLM tool agent "prefers the wrong tool", first confirm the preferred tool actually returns data in production.
- **Never give a model-chosen fetch more than anonymous authority.** Before reusing an internal secret, check what it actually is in production, not what its name or comments suggest. The relay-key comment said "dedicated … least privilege", but production held an enterprise value.
- **Tell rejection reasons apart before throwing away shared state.** A 401 from one route is evidence about that route, not about the credential.
- **Tests that mock `fetch` cannot catch an auth wall.** The regression tests now pin the header, the redirect mode, and both 401 kinds (`widget-agent relay — data fetch credentials`, `widget-agent relay — anonymous data session` in `tests/widget-builder.test.mjs`).

## Related Issues

- #8720, the fix. #3541 removed Origin trust.
- #8080 (open as of this writing) replaces the substring blocklist in `isWidgetEndpointAllowed` with an executable route allowlist. That is the remaining scope control for model-chosen paths.
- [credential-less-request-403-read-as-missing-subscription](../logic-errors/credential-less-request-403-read-as-missing-subscription.md), a similar misreading in the same builder, on the client side.
- Follow-ups found during production validation, not fixed here:
  - The model invents FRED series IDs outside `ALLOWED_FRED_SERIES`.
  - Tool results are cut at 20,000 characters in `sanitizeToolContent`.
  - The system prompt has no date.
  - A "30 day" gold/silver chart was drawn from intraday sparklines, because there is no daily commodity history.
  - One of three production runs hit the 120 s PRO timeout.
