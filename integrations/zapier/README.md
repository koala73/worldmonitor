# WorldMonitor Zapier integration

This folder is a [Zapier Platform CLI](https://docs.zapier.com/integrations/build-cli/overview) app. It calls the public WorldMonitor REST API with an API key. It does not import browser, server, or Edge code from the rest of this repository.

WorldMonitor users who already have an API Starter or API Business key can connect Zapier to country risk, chokepoint status, latest conflict events, and new disease-outbreak alerts.

This pull request does not register the app with Zapier or push a version. Elie does those account steps.

## What it calls

| Zapier step | Kind | HTTP | Path |
| --- | --- | --- | --- |
| Account connection test | Auth | GET | `/api/intelligence/v1/get-country-risk?country_code=US` |
| Find Country Risk | Search | GET | `/api/intelligence/v1/get-country-risk` |
| Find Chokepoint Status | Search | GET | `/api/supply-chain/v1/get-chokepoint-status` |
| Find Latest Conflict Events | Search | GET | `/api/conflict/v1/list-ucdp-events` |
| New Disease Outbreak | Polling trigger | GET | `/api/health/v1/list-disease-outbreaks` |

Auth uses the canonical header `X-WorldMonitor-Key`. `X-Api-Key` is an API alias and is not sent by this app.

`GET /api/health` is public and does not prove a key is valid, so the connection test does not use it.

Air-quality alerts exist at `/api/health/v1/list-air-quality-alerts` but the documented rows have no stable `id`. This app does not poll that list.

## Local setup

Use Node 18 or newer. Zapier runs integrations on Node 22. The repository `.nvmrc` is 24, which is fine for these tests.

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

The Zapier CLI binary is `zapier-platform` on platform v19. Older docs still say `zapier`.

```bash
cd integrations/zapier
npx zapier-platform validate
```

`zapier-platform register` and `zapier-platform push` need a Zapier developer login. Do not run them in CI or in this pull request.

When Elie is ready to upload a private version:

```bash
npx zapier-platform register
npx zapier-platform push
```

`register` creates the integration. `push` uploads the current `package.json` version. Branding that the CLI does not store (logo, category, intended audience) is set in the [Platform UI](https://developer.zapier.com) after the first push.

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
- Put that account on API Starter or API Business so Zapier staff can create a `wm_` key.
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
