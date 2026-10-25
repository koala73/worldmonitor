# WorldMonitor Zapier integration

This folder is a [Zapier Platform CLI](https://docs.zapier.com/integrations/build-cli/overview) app. It calls the public WorldMonitor REST API with an API key. It does not import browser, server, or Edge code from the rest of this repository.

WorldMonitor users who already have an API Starter or API Business key can connect Zapier to instant breaking-news, large-market-move, natural-hazard, chokepoint-disruption and country-risk-surge alerts, keyword news search, the strategic risk overview, country risk, chokepoint status, latest conflict events, and new disease-outbreak alerts.

The app is registered on Zapier as integration 248027 and `.zapierapprc` links this folder to it. Version 1.1.0 is pushed and every live Zap runs on it; 1.2.0 (this folder) is not pushed yet. Pushing is an account step Elie does, after the relay, the shipping webhook worker and the API sender are deployed and a real delivery of each new event has been observed carrying `X-WM-Signature-V2`; 1.2.0 accepts nothing else.

## What it calls

| Zapier step | Kind | HTTP | Path |
| --- | --- | --- | --- |
| Account connection test | Auth | GET | `/api/intelligence/v1/get-country-risk?country_code=US` |
| New Breaking News Alert | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: news.breaking` and a `scope`; sample rows from GET `/api/news/v1/list-feed-digest?variant=full` |
| New Large Market Move | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: market.move` and a `scope`; sample rows from GET `/api/market/v1/list-market-quotes`, `list-commodity-quotes`, `list-crypto-quotes` |
| New Natural Hazard | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: natural.hazard` and a `scope`; sample rows from GET `/api/seismology/v1/list-earthquakes` and `/api/natural/v1/list-natural-events` |
| New Chokepoint Disruption | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: chokepoint.disruption`; sample rows from GET `/api/supply-chain/v1/get-chokepoint-status` |
| New Country Risk Surge | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: country.risk_surge`; sample rows from GET `/api/intelligence/v1/get-risk-scores` |
| Find News by Keyword | Search | GET | `/api/news/v1/list-feed-digest?variant=` (keyword and category match run in the app; the API has no keyword parameter) |
| Find Strategic Risk Overview | Search | GET | `/api/intelligence/v1/get-risk-scores` (`strategicRisks[0]` plus the five highest `ciiScores`) |
| List Monitored Countries (fills the Countries dropdown) | Hidden trigger | none | Reads `event-triggers.json` |
| Find Country Risk | Search | GET | `/api/intelligence/v1/get-country-risk` |
| Find Chokepoint Status | Search | GET | `/api/supply-chain/v1/get-chokepoint-status` |
| List Chokepoints (fills the Chokepoint dropdown) | Hidden trigger | GET | `/api/supply-chain/v1/get-chokepoint-status` |
| Find Latest Conflict Events | Search | GET | `/api/conflict/v1/list-ucdp-events?country=` |
| New Disease Outbreak | Polling trigger | GET | `/api/health/v1/list-disease-outbreaks` |

### Instant triggers

The five instant triggers are REST hooks on the WorldMonitor event webhooks (`docs/api-shipping-v2.mdx`). They need an API plan key: `POST /api/v2/shipping/webhooks` requires the `apiAccess` entitlement.

Two kinds of event share the plumbing. Chokepoint disruption and country risk surge are threshold events: the server re-evaluates a condition every 5 minutes and one crossing is one delivery. Breaking news, large market move and natural hazard are occurrence events: each is delivered once per story, move or hazard (`eventId` in the body: `rss_` for a story link, `mkt_` for a symbol, direction and severity band per UTC day, `eq:` or `nat:` plus the feed's own id for a hazard), a failed delivery is retried every 5 minutes under the same `X-WM-Delivery-Id` (for two hours, a day for hazards) and then dropped, and each Zap receives at most 20 deliveries an hour and 100 a day (30 and 150 for hazards; overflow is dropped and counted on the server, never batched). Their filters travel in the registration body's `scope` object, validated by the server against the event's `inputSchema` in the registry; a filter the event does not define is a 400 that the Zap editor shows verbatim.

- New Breaking News Alert: `keywords` (whole words, any-of, up to 20), `categories` (the classifier's 14 categories), `countries` (ISO 3166-1 alpha-2; a headline the relay could not attribute to a country never matches a country filter), `importance_floor` (default 69), `severity_floor` (default high, which is every headline the relay queues). Deliveries carry `countryCodes` and `matchedKeywords`; sample rows come from the public digest, which has no country attribution, so their `countryCodes` is empty.
- New Large Market Move: `asset_classes`, `symbols` (as WorldMonitor lists them, upper-cased), `min_abs_pct` (default 10; the relay only publishes moves of 5 percent or more, 10 for crypto), `direction`. Sample rows are the largest current moves and ignore the percent floor.
- New Natural Hazard: `hazard_types` (`earthquakes` and the natural-events categories), `min_magnitude` (earthquakes only, default 5.5), `min_alert_level` (GDACS events only, default Orange, which is every GDACS event WorldMonitor stores; an escalation from Orange to Red is a second delivery), `countries` (a hazard placed in no country, such as a mid-ocean quake, never matches a country filter). A hazard is new when the server first sees it: earthquakes from USGS and Earthquakes Canada, storms, wildfires, floods, volcanoes and other events from NASA EONET, GDACS, the National Hurricane Center and the western-Pacific cyclone feed. A quake revised across `min_magnitude` after it was first seen is not delivered, and another agency's copy of a quake or storm already seen is not a new hazard. Deliveries carry `countryCodes`; sample rows come from the two list RPCs, which carry no country, so their `countryCodes` is empty and the country filter is not applied to them.

- `performSubscribe` registers the Zap's target URL and returns `{ id, subscriberId, secret, eventType, expiration_date }`. Zapier stores it as `bundle.subscribeData`. `expiration_date` is 29 days out so Zapier re-subscribes before the server's 30-day subscription TTL.
- `perform` requires `X-WM-Signature-V2` on every delivery: `sha256=HMAC-SHA256(secret, timestamp.deliveryId.event.rawBody)` over the exact header strings and body bytes, compared in constant time, with `X-WM-Timestamp` within 300 seconds of Zapier's clock and well-formed `X-WM-Delivery-Id` and `X-WM-Event`. There is no fallback to the legacy body-only `X-WM-Signature`: a delivery without V2, one that does not verify, a stale timestamp, or a Zap with no stored secret raises an error instead of running the Zap. Zaps on an earlier version keep that version's code until they are migrated to 1.2.0. The row `id` is `X-WM-Delivery-Id`: the worker mints it once per crossing and reuses it on retries, so a later step can dedupe on it. Zapier itself does not dedupe REST-hook deliveries: a retried POST runs the Zap again with the same id. The server's per-subscriber hysteresis and cooldown decide what is sent.
- `performUnsubscribe` calls `DELETE /api/v2/shipping/webhooks/{subscriberId}`; a `404` (already gone) is not an error.
- `performList` shapes live status rows exactly like a delivery so field mapping in the editor survives the switch to real events. Sample ids are `sample:<entity>:<feed time>`.

Event definitions (label, description, thresholds, cooldown, id rule, payload schema, sample) come from `event-triggers.json`, a byte-for-byte copy of the repo's `shared/event-triggers.json` (`test/event-registry.test.js` pins it; run `cp shared/event-triggers.json integrations/zapier/event-triggers.json` after a registry change). The same registry drives the delivery worker and the OpenAPI `webhooks` block.

Defaults: New Chokepoint Disruption sends `alertThreshold` 50 and `minLiveSignal` 15 (the in-app alert rule's floor), both editable per Zap. With a live floor the server re-arms a chokepoint only once its score is 10 points under the threshold or its live signal is under 5, and refires at most once per 12 hours. New Country Risk Surge has no threshold inputs; the server rule is a 15-point rise within 24 hours into the high band (index 70 or more), once per surge with a 24-hour cooldown per country, chosen on a 90-day backtest (`docs/research/2026-10-17-zapier-event-triggers-backtest.md`).

### Searches and polling triggers

Find News by Keyword downloads the digest for the chosen variant and matches the keyword (case-insensitive) and optional category in the app, since `list-feed-digest` takes only `variant` and `lang`; it returns the 25 most important matches, de-duplicated by link. Find Strategic Risk Overview returns one row from `get-risk-scores`: the global `strategicRisks[0]` (`level`, `score`, `factors`; `trend` is always `TREND_DIRECTION_UNSPECIFIED` today) plus the highest Country Instability Index readings as `topCountries` (its one input, Countries to Include, defaults to 5; Zapier requires every search to take an input), or no row when the API has no roll-up.

Find Latest Conflict Events sends only `country`. The API accepts `start`, `end`, and `page_size` but ignores them, so the search does not offer them. It sorts by `dateStart` and returns the newest 25 events.

New Disease Outbreak sorts by `publishedAt`, newest first. The API groups rows by source, and Zapier reads the first rows as the newest.

API errors reach the Zap with the API's own message, and field-level `violations` name the rejected field.

Auth uses the canonical header `X-WorldMonitor-Key`. `X-Api-Key` is an API alias and is not sent by this app.

`GET /api/health` is public and does not prove a key is valid, so the connection test does not use it.

Air-quality alerts exist at `/api/health/v1/list-air-quality-alerts` but the documented rows have no stable `id`. This app does not poll that list.

## Local setup

Use Node 22 or newer. Zapier CLI 19.2.1 requires it, and Zapier runs integrations on Node 22. The repository `.nvmrc` is 24.

1. Create an API key at [Find or replace your API key](https://www.worldmonitor.app/docs/api-keys) if you want a live `zapier-platform invoke` check. Unit tests mock HTTP and do not need a key.
2. Install this folder only.

```bash
cd integrations/zapier
npm install
```

3. Run the nock tests.

```bash
npm test
```

Do not run `npm install` from the repo root for this app. Root CI lint, typecheck, and tests do not enter this folder.

Do not commit `package-lock.json` here. Root `security-audit.yml` must list every tracked lockfile, and a stray lockfile fails `tests/ci-workflow-coverage.test.mts`. `cli/` follows the same pattern. `npm install` still creates a local lockfile.

## Validate and push

The Zapier CLI is a pinned dev dependency. Its binary is `zapier-platform` on platform v19. Older docs still say `zapier`.

```bash
cd integrations/zapier
npm run validate
```

Validate runs Zapier's integration checks locally. All 27 pass. The one remaining warning (D003) asks for a connection label, which Zapier lists as optional. The API has no endpoint that names the account behind a key, and a label must not show the key.

`zapier-platform push` needs a Zapier developer login (`npx zapier-platform login`, or a deploy key). Do not run it in CI or from a pull request.

To upload 1.2.0 (`push` reads `.zapierapprc`; do not run `zapier-platform register`, which would create a second integration). Order: deploy the relay (API fan-out tee), the shipping webhook worker (occurrence pipeline) and the API sender; observe a real `news.breaking`, `market.move` and `natural.hazard` delivery, each carrying `X-WM-Signature-V2` and `X-WM-Timestamp`; then push 1.2.0; then migrate existing Zaps to 1.2.0 (`npx zapier-platform migrate 1.1.0 1.2.0`). 1.2.0 rejects a delivery without V2, so it must not go out before the senders:

```bash
cd integrations/zapier
npm run validate
npx zapier-platform push
```

`push` uploads the current `package.json` version. Branding that the CLI does not store (logo, category, intended audience) is set in the [Platform UI](https://developer.zapier.com).

To exercise the new triggers against production with a `wm_` key (read-only calls only; `performSubscribe` writes a subscription, so run it only when you mean to):

```bash
npx zapier-platform invoke auth test
npx zapier-platform invoke trigger chokepoint_disruption --inputData '{"chokepoint":"hormuz_strait"}'   # performList sample rows
npx zapier-platform invoke trigger country_risk_surge --inputData '{"countries":["IR","UA"]}'         # performList sample rows
npx zapier-platform invoke trigger news_breaking --inputData '{"keywords":["hormuz"],"importance_floor":"69"}'   # performList sample rows
npx zapier-platform invoke trigger market_move --inputData '{"asset_classes":["equity","crypto"]}'              # performList sample rows
npx zapier-platform invoke trigger natural_hazard --inputData '{"hazard_types":["earthquakes","severeStorms"]}'   # performList sample rows
npx zapier-platform invoke search find_news --inputData '{"keyword":"hormuz"}'
npx zapier-platform invoke search strategic_risk_overview
```

## Zapier review checklist

Elie submits the public listing. Work through [Zapier integration publishing requirements](https://docs.zapier.com/integrations/publish/integration-publishing-requirements) and [branding guidelines](https://docs.zapier.com/integrations/publish/branding-guidelines) before clicking Publish.

### Branding

- App name is `WorldMonitor`. Do not add "app" or "integration".
- Description follows `WorldMonitor is a...` and stays under 160 characters. Example: `WorldMonitor is a real-time global intelligence dashboard for geopolitics, military activity, markets, climate, and maritime risk.`
- Homepage is `https://www.worldmonitor.app`, not the dashboard login page.
- Logo is a square transparent PNG, at least 512x512 px and 72 DPI. Center the mark in the square. Do not put the word WorldMonitor in the image.
- Primary color is a brand color other than `#FFFFFF`.
- Category should match the product today. Business Intelligence / Dashboards or News & Lifestyle is closer than a narrow AI category.

### Docs

- API docs: [Authentication](https://www.worldmonitor.app/docs/usage-auth) and [API reference](https://www.worldmonitor.app/docs/api-reference).
- Publish a help article on worldmonitor.app that shows how to create a `wm_` key and connect Zapier.
- User-facing Zapier copy stays in English.

### Test account

- Create a non-expiring WorldMonitor account for `integration-testing@zapier.com`.
- Sign-up sends a verification code to that address, which only Zapier reads. Create the user in the Clerk dashboard with the email marked verified instead.
- Comp the account to `api_starter` with `payments/billing:grantComplimentaryEntitlement`, so Zapier staff can create a `wm_` key. Pro plans cannot create API keys.
- Zapier must be able to change the password unless the account is passwordless.
- Turn on every Zapier step in a Zapier account, leave those Zaps on, and keep at least one successful run each.
- Add a Zapier team admin whose email is on the worldmonitor.app domain.

### Public listing

1. Log in to the Platform UI.
2. Open the integration and click Publish.
3. Complete the form. Accept the Zapier Platform Agreement.
4. Wait for review. Zapier says a developer replies in one week or less.
5. After approval the listing is Beta for 90 days, then Public.

Ownership rule: only the API owner or a contracted developer can take this integration public. A third-party clone of this folder must stay private.

## Isolation

Root `npm run lint` only lints `src`, `server`, `api`, `tests`, `e2e`, `scripts`, and `middleware.ts`. Root `npm run typecheck` includes `src` only. Root test scripts use explicit globs under `tests/` and `api/`. `lint:md` ignores `integrations/zapier/**`.
