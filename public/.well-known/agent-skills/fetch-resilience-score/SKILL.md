---
name: fetch-resilience-score
version: 1
description: Retrieve the composite country resilience score (0-100) and its domain/pillar breakdown for a single country. Use when the user asks how resilient a country is, or wants its numeric resilience score, trend, or per-domain breakdown.
---

# fetch-resilience-score

Use this skill when the user asks how "resilient" a country is, or wants the numeric resilience score, trend, or per-domain breakdown. The score is a composite of economic, infrastructure, energy, social-governance, health-food, and recovery domains, updated every 6 hours.

## Authentication — required

`/api/resilience/v1/get-resilience-score` is Pro-tier. Agents and other server-to-server callers MUST present an API key in the `X-WorldMonitor-Key` header. `Authorization: Bearer …` is for MCP/OAuth or Clerk JWTs — **not** raw API keys.

```
X-WorldMonitor-Key: wm_0123456789abcdef0123456789abcdef01234567
```

The key must be attached to a Pro subscription. Unauthenticated or free-tier requests return `401` / `403`. Issue a key at https://www.worldmonitor.app/pro.

## Endpoint

```
GET https://api.worldmonitor.app/api/resilience/v1/get-resilience-score
```

## Parameters

| Name | In | Required | Shape |
|---|---|---|---|
| `countryCode` | query | yes | ISO 3166-1 alpha-2, uppercase (e.g. `DE`, `KE`, `BR`) |

## Response shape

```json
{
  "countryCode": "DE",
  "overallScore": 78.4,
  "level": "high",
  "trend": "stable",
  "change30d": -0.2,
  "lowConfidence": false,
  "imputationShare": 0.04,
  "baselineScore": 79.1,
  "stressScore": 78.4,
  "stressFactor": 0.216,
  "dataVersion": "2026-04-23",
  "scoreInterval": { "p05": 76.1, "p95": 80.7 },
  "schemaVersion": "2.0",
  "headlineEligible": true,
  "domains": [
    { "id": "economic", "score": 82.1, "weight": 0.17, "dimensions": [] }
  ],
  "pillars": [
    {
      "id": "structural-readiness",
      "score": 80.0,
      "weight": 0.4,
      "coverage": 0.92,
      "domains": []
    }
  ]
}
```

Key fields for agents:

- `overallScore` (0–100): headline number.
- `level`: `low` / `medium` / `high` — human-readable bucket.
- `trend`: `rising` / `stable` / `falling` — direction of the score over the past period.
- `change30d`: rolling 30-day delta.
- `scoreInterval`: `{p05, p95}` confidence band — quote this when the user asks for precision.
- `domains`: six domain components with IDs `economic`, `infrastructure`, `energy`, `social-governance`, `health-food`, and `recovery`.
- `pillars`: three pillar components with IDs `structural-readiness`, `live-shock-exposure`, and `recovery-capacity`.

## Worked example

```bash
curl -s -H "X-WorldMonitor-Key: $WM_API_KEY" \
  'https://api.worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=DE' \
  | jq '{country: .countryCode, score: .overallScore, level, trend, change30d}'
```

## Errors

- `400` — `countryCode` missing or malformed.
- `401` — missing `X-WorldMonitor-Key`.
- `403` — key present but not attached to a Pro-tier subscription.
- `404` — country not yet scored (rare; some micro-states).
- `429` — per-key rate limit hit.

## When NOT to use

- For a sorted list across all countries, call `GetResilienceRanking` (`/api/resilience/v1/get-resilience-ranking`) instead of N per-country calls.
- For a narrative summary rather than a number, use `fetch-country-brief`.

## References

- OpenAPI: [ResilienceService.openapi.yaml](https://www.worldmonitor.app/openapi.yaml) — operation `GetResilienceScore`.
- Auth matrix: https://www.worldmonitor.app/docs/usage-auth
- Methodology: https://www.worldmonitor.app/docs/documentation
