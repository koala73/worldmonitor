# WorldMonitor Zapier integration

This folder is a [Zapier Platform CLI](https://docs.zapier.com/integrations/build-cli/overview) app. It calls the public WorldMonitor REST API with an API key. It does not import browser, server, or Edge code from the rest of this repository.

WorldMonitor users who already have an API Starter or API Business key can connect Zapier to instant chokepoint-disruption and country-risk-surge alerts, country risk, chokepoint status, latest conflict events, and new disease-outbreak alerts.

The app is registered on Zapier as integration 248027 and `.zapierapprc` links this folder to it. Version 1.0.0 is pushed; 1.1.0 (this folder) is not yet. Pushing is an account step Elie does.

## What it calls

| Zapier step | Kind | HTTP | Path |
| --- | --- | --- | --- |
| Account connection test | Auth | GET | `/api/intelligence/v1/get-country-risk?country_code=US` |
| New Chokepoint Disruption | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: chokepoint.disruption`; sample rows from GET `/api/supply-chain/v1/get-chokepoint-status` |
| New Country Risk Surge | Instant (REST hook) trigger | POST, DELETE | `/api/v2/shipping/webhooks` with `eventType: country.risk_surge`; sample rows from GET `/api/intelligence/v1/get-risk-scores` |
| List Monitored Countries (fills the Countries dropdown) | Hidden trigger | none | Reads `event-triggers.json` |
| Find Country Risk | Search | GET | `/api/intelligence/v1/get-country-risk` |
| Find Chokepoint Status | Search | GET | `/api/supply-chain/v1/get-chokepoint-status` |
| List Chokepoints (fills the Chokepoint dropdown) | Hidden trigger | GET | `/api/supply-chain/v1/get-chokepoint-status` |
| Find Latest Conflict Events | Search | GET | `/api/conflict/v1/list-ucdp-events?country=` |
| New Disease Outbreak | Polling trigger | GET | `/api/health/v1/list-disease-outbreaks` |

### Instant triggers

The two instant triggers are REST hooks on the WorldMonitor event webhooks (`docs/api-shipping-v2.mdx`). They need an API plan key: `POST /api/v2/shipping/webhooks` requires the `apiAccess` entitlement.

- `performSubscribe` registers the Zap's target URL and returns `{ id, subscriberId, secret, eventType, expiration_date }`. Zapier stores it as `bundle.subscribeData`. `expiration_date` is 29 days out so Zapier re-subscribes before the server's 30-day subscription TTL.
- `perform` recomputes `sha256=HMAC-SHA256(rawBody, secret)` over the exact bytes received and compares it with `X-WM-Signature` in constant time. A delivery that does not verify, or a Zap with no stored secret, raises an error instead of running the Zap. The row `id` is `X-WM-Delivery-Id`: the worker mints it once per crossing and reuses it on retries, so a later step can dedupe on it. Zapier itself does not dedupe REST-hook deliveries: a retried POST runs the Zap again with the same id. The server's per-subscriber hysteresis and cooldown decide what is sent.
- `performUnsubscribe` calls `DELETE /api/v2/shipping/webhooks/{subscriberId}`; a `404` (already gone) is not an error.
- `performList` shapes live status rows exactly like a delivery so field mapping in the editor survives the switch to real events. Sample ids are `sample:<entity>:<feed time>`.

Event definitions (label, description, thresholds, cooldown, id rule, payload schema, sample) come from `event-triggers.json`, a byte-for-byte copy of the repo's `shared/event-triggers.json` (`test/event-registry.test.js` pins it; run `cp shared/event-triggers.json integrations/zapier/event-triggers.json` after a registry change). The same registry drives the delivery worker and the OpenAPI `webhooks` block.

Defaults: New Chokepoint Disruption sends `alertThreshold` 50 and `minLiveSignal` 15 (the in-app alert rule's floor), both editable per Zap. With a live floor the server re-arms a chokepoint only once its score is 10 points under the threshold or its live signal is under 5, and refires at most once per 12 hours. New Country Risk Surge has no threshold inputs; the server rule is a 15-point rise within 24 hours into the high band (index 70 or more), once per surge with a 24-hour cooldown per country, chosen on a 90-day backtest (`docs/research/2026-10-17-zapier-event-triggers-backtest.md`).

### Searches and polling triggers

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

To upload 1.1.0 (`push` reads `.zapierapprc`; do not run `zapier-platform register`, which would create a second integration):

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
