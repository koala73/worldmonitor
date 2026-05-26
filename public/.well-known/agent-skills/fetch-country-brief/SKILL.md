---
name: fetch-country-brief
version: 1
description: Retrieve the current AI-generated strategic intelligence brief for a country, keyed by ISO 3166-1 alpha-2 code.
---

# fetch-country-brief

Use this skill when the user asks for a summary of the current geopolitical, economic, or security situation in a specific country. The endpoint returns a fresh AI-generated brief composed from the latest news, market, conflict, and infrastructure signals World Monitor tracks for that country.

## Authentication

Server-to-server callers (agents, scripts, SDKs) MUST present an API key in the `X-WorldMonitor-Key` header. `Authorization: Bearer …` is for MCP/OAuth or Clerk JWTs — **not** raw API keys.

```
X-WorldMonitor-Key: wm_live_...
```

Browser requests from `worldmonitor.app` get a free pass via CORS Origin trust, but agents will never hit that path. Issue a key at https://www.worldmonitor.app/pro.

## Endpoint

```
GET https://api.worldmonitor.app/api/intelligence/v1/get-country-intel-brief
```

## Parameters

| Name | In | Required | Shape | Notes |
|---|---|---|---|---|
| `country_code` | query | yes | ISO 3166-1 alpha-2, uppercase (e.g. `US`, `IR`, `KE`) | Case-sensitive server-side. Lowercase is rejected with 400. |
| `framework` | query | no | free text, ≤ 2000 chars | Optional analytical framing appended to the system prompt (e.g. `"focus on energy security"`). |

## Response shape

```json
{
  "countryCode": "IR",
  "countryName": "Iran",
  "brief": "Multi-paragraph AI-generated brief …",
  "model": "gpt-4o-mini",
  "generatedAt": 1745421600000
}
```

`generatedAt` is Unix epoch milliseconds. `model` identifies which LLM produced the text.

## Worked example

```bash
curl -s -H "X-WorldMonitor-Key: $WM_API_KEY" \
  'https://api.worldmonitor.app/api/intelligence/v1/get-country-intel-brief?country_code=IR' \
  | jq -r '.brief'
```

With an analytical framework:

```bash
curl -s --get -H "X-WorldMonitor-Key: $WM_API_KEY" \
  'https://api.worldmonitor.app/api/intelligence/v1/get-country-intel-brief' \
  --data-urlencode 'country_code=TR' \
  --data-urlencode 'framework=focus on energy corridors and Black Sea shipping'
```

## Errors

- `400` — `country_code` missing, not 2 letters, or not uppercase.
- `401` — missing `X-WorldMonitor-Key` (server-to-server callers).
- `429` — rate limited; retry with backoff.
- `5xx` — transient upstream model failure; retry once after 2s.

## When NOT to use

- For rankings or comparisons across countries, use `fetch-resilience-score` per country and aggregate client-side, or call the `GetResilienceRanking` RPC directly.
- For raw news events rather than synthesized narrative, use `SearchGdeltDocuments` (`/api/intelligence/v1/search-gdelt-documents`).

## References

- OpenAPI: [IntelligenceService.openapi.yaml](https://www.worldmonitor.app/openapi.yaml) — operation `GetCountryIntelBrief`.
- Auth matrix: https://www.worldmonitor.app/docs/usage-auth
- Documentation: https://www.worldmonitor.app/docs/documentation
