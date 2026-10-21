---
title: "USDA FAS PSD lives on api.fas.usda.gov with USDA_FAS_PSD_API_KEY and X-Api-Key"
module: food-stocks
date: 2026-08-12
category: integration-issues
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "PSD seeder cannot authenticate because USDA_FAS_API_KEY is unset"
  - "apps.fas.usda.gov/OpenData/api/psd returns HTTP 500 An error has occurred"
  - "api.fas.usda.gov with API_KEY header returns 403 API_KEY_MISSING"
  - "World snapshot is empty even when country rows parse — validateFoodStocks fails"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - service_object
tags:
  - usda
  - fas
  - psd
  - food-stocks
  - api-key
  - seeder
  - railway
---

# USDA FAS PSD lives on api.fas.usda.gov with USDA_FAS_PSD_API_KEY and X-Api-Key

## Problem

The food-stocks seeder targeted the legacy Open Data host and the wrong env name. Live credentials in `.env.local` are `USDA_FAS_PSD_API_KEY`. The working API is `https://api.fas.usda.gov/api/psd` authenticated with header `X-Api-Key`.

## Symptoms

- `.env.local` has `USDA_FAS_PSD_API_KEY` and does not have `USDA_FAS_API_KEY`
- `GET https://apps.fas.usda.gov/OpenData/api/psd/commodities` with `API_KEY` → HTTP 500 `{"message":"An error has occurred."}`
- `GET https://api.fas.usda.gov/api/psd/commodities` with `X-Api-Key` → 200, 63 commodities
- Same host with only `API_KEY` header → 403 `API_KEY_MISSING`
- World rows use `countryCode: "00"`; treating only `0` / `"0"` as world drops `_world` and `validateFoodStocks` fails

## What Didn't Work

- Header `API_KEY` against `apps.fas.usda.gov/OpenData` — the documented older swagger host now 500s
- Query `api_key=` — works (api.data.gov style) but puts the secret in the URL and in access logs. A probe in this investigation leaked the key that way
- Never `source .env.local` under zsh — zsh executes `KEY=value` lines and prints the secret to stderr

> **ACTION REQUIRED before the Railway variable is set.** The key used during this
> investigation was placed on a query string and therefore recorded in USDA access
> logs. Register a NEW key and set that one as `USDA_FAS_PSD_API_KEY` — do not
> deploy the exposed key. It is a free, read-only, public-data credential with no
> PII scope, so this is a hygiene step rather than an incident, but the exposed
> value must not become the production secret. This ordering is deliberate: the
> post-deploy checklist otherwise reads "set the key" with no indication that the
> obvious key to hand is the compromised one.

## Solution

1. Load `USDA_FAS_PSD_API_KEY` via `loadEnvFile({ only: [...] })` or `node --env-file=.env.local`
2. Fetch `https://api.fas.usda.gov/api/psd/commodity/{code}/country/all/year/{year}` and `.../world/year/{year}`
3. Send `X-Api-Key` (official swagger security scheme). Do not put the key on the query string
4. Map `/^0+$/` country codes to `_world` — live world rows are `"00"`

Verified 2026-08-12 against the live key: Brazil corn 2021 returned 15 rows; country/all returned 1875; world returned 15. `fetchPsdCommodityYear` produced 1890 raw rows, Brazil production 116000, and a finite world stocks-to-use. Historical fixture balances (imports/exports/consumption/ending) have been revised by later WASDE releases; production still matched.

## Why This Works

The current FAS Open Data portal swagger host is `api.fas.usda.gov`. The gateway accepts `X-Api-Key` and `api_key`; it does not accept the old `API_KEY` header. World aggregates are tagged `"00"`, not numeric `0`.

## Prevention

- Name the env `USDA_FAS_PSD_API_KEY` in `.env.example`, Railway, and docs
- Assert the seeder contains `api.fas.usda.gov` and `'X-Api-Key': apiKey`
- Unit-test `normalizePsdCountryCode('00') === '_world'`
- Load secrets with `node --env-file`; never log request URLs that might contain `api_key`

## Related Issues

- #6440 / PR #6531 (food-stocks ingestion; host/key fix is on that PR, unmerged as of this writing)
- `docs/solutions` security gotcha: zsh `source .env.local` leaks secrets
