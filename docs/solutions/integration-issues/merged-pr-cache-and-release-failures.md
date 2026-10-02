---
title: "Cache sweep and desktop release failures after PRs 7752 and 7754"
date: 2026-09-05
category: integration-issues
module: CI and production cache configuration
problem_type: integration_issue
component: deploy_config
severity: high
---

# Cache sweep and desktop release failures after PRs 7752 and 7754

## Evidence

The latest two merges were [#7752](https://github.com/koala73/worldmonitor/pull/7752)
at 18:44 UTC and [#7754](https://github.com/koala73/worldmonitor/pull/7754)
at 18:38 UTC on September 5, 2026. Their red checks had separate causes.

| Failed check | Direct evidence | Correction |
| --- | --- | --- |
| [Prepare Desktop Release](https://github.com/koala73/worldmonitor/actions/runs/33984691487) | The configuration step reports four empty secrets. No desktop build started. | Configure the existing required secrets before release preparation. |
| [Live API Cache/Auth Sweep](https://github.com/koala73/worldmonitor/actions/runs/33984985761) | The sweep started at 18:44. Vercel reported the merge deployment ready at 18:51:38. | Start the deployment check on successful Vercel Production events. |
| Same sweep, anonymous ACLED RPC | HTTP 401 carries `Cache-Control: max-age=1800` on the API host. The same path on `www` returns `no-store`. | Correct the API cache rule's error TTL and browser TTL. |
| Same sweep, document cache | After deployment, fresh blog and agent-file requests have the new CDN header. Some canonical cache entries still have old headers. | Refresh the affected cache entries after the header deployment, then repeat canonical GET probes. |

The workflow correction retains the six-hour schedule, manual runs, and all nine
mandatory assertions. Probe-only changes that do not deploy run on the schedule
or through manual dispatch. The deployed SHA selects the test file. A passing
alias probe proves current production behavior, not deployment ancestry.

## Correct the API cache rule

The live `http_request_cache_settings` ruleset is
`76a1bd6433544d75a9762404d5c61e4b`, version 60 at inspection.
The rule `API - api.worldmonitor.app use cache-control`, ID
`08c76b45c9c84396bf9212fd535c297f`, sets both error ranges to TTL `0`.
It does not specify `browser_ttl`. The zone's browser TTL is `1800` seconds.

Cloudflare's status TTL overrides origin cache instructions. A zero TTL stores
and revalidates the response. Use `-1` to prevent storage. See the
[Cloudflare cache rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

After approval for a production cache change, edit only these fields on that rule.
Preserve its expression, ID, position, and other action parameters.

```json
{
  "browser_ttl": { "mode": "respect_origin" },
  "edge_ttl": {
    "mode": "bypass_by_default",
    "status_code_ttl": [
      { "status_code_range": { "from": 400, "to": 499 }, "value": -1 },
      { "status_code_range": { "from": 500, "to": 599 }, "value": -1 }
    ]
  }
}
```

This is a field change, not a replacement ruleset payload. Read the current rule
before applying it. The existing document-rule script manages a different rule.
Running `cloudflare-cache-rule.mjs --apply` cannot repair this API rule.

Verify two anonymous GETs to
`https://api.worldmonitor.app/api/conflict/v1/list-acled-events`.
Both must return HTTP 401 with `no-store` and the API's JSON rejection body, and
neither may be a shared-cache HIT. A `cf-cache-status` of `EXPIRED` also proves the
entry was stored. A Cloudflare HTML challenge page from an operator machine proves
nothing; verify from the Actions runner with a manual sweep run instead.
Repeat the full sweep to verify that public weather and public RPC caching still work.

## Refresh old document entries

The document rule already matched the merged expression at inspection. Reapplying
that unchanged rule is not the missing deployment step.

Observed after deployment:

- `/docs/documentation` reached a Cloudflare HIT.
- `/blog/glossary/ais/` reached a HIT on its second request.
- `/blog/` still returned repeated MISS responses. Some responses lacked
  `CDN-Cache-Control` and retained a pre-deployment `x-vercel-id`.
- `/llms.txt` returned a HIT with old headers and an age above 1,200 seconds.
- Unique query strings on `/blog/` and `/llms.txt` returned the new
  `CDN-Cache-Control: public, s-maxage=600, stale-while-revalidate=60` header.

These comparisons isolate stale cached metadata. They do not prove which cache
tier retains each entry. After approval, re-probe each canonical URL first and
purge at Cloudflare only the ones still serving old headers. On September 6,
`/llms.txt` already reached a HIT with the new header while `/blog/` still
alternated. The header-less `/blog/` responses were Cloudflare MISSes whose
`x-vercel-id` was hours older than the request, so that copy is served from a tier
at or behind Vercel and a Cloudflare purge alone may not clear it. If old headers
remain, inspect the Vercel cache before further changes. Do not change origin TTLs
or increase the test retry budget without new evidence.

Use GET requests for acceptance. The cache rule excludes HEAD requests. Keep
canonical requests free of query strings. Query requests bypass this document
rule and cannot prove cache acceptance. The full sweep also checks that Markdown,
RSC, and docs MCP responses stay outside the HTML cache.

## Supply the desktop release configuration

The repository secret-name inventory confirmed that these four entries were absent:

- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_WS_RELAY_URL`
- `VITE_PMTILES_URL_PUBLIC`
- `CONVEX_URL`

Configure the approved production values as repository Actions secrets through a
secure channel. Do not commit values or replace the preflight with defaults.
The same requirements apply to the desktop build workflow. The Sentry dependency
change triggered release preparation through `package.json` and `package-lock.json`.
It did not cause the missing configuration.

Release preparation creates tags and dispatches a release build once these values
exist. Coordinate configuration and the next scheduled or manual run with the
release owner. No secrets, tags, builds, or production settings changed during
this diagnosis.

## Separate ingestion failure

The [Seed Freshness Monitor](https://github.com/koala73/worldmonitor/actions/runs/33985198497)
also reported `crossStraitActivityTaiwanMnd` and `wildfires` as `SEED_ERROR`.
Its accepted-problem baseline expired at 18:00 UTC. This is production ingestion
evidence, not a Sentry or document-cache regression. Keep the failure visible.
Source recovery requires source-specific natural-run evidence before acceptance.

## Verification and limits

The new deployment-trigger regression failed on the original workflow. All 40
workflow tests passed after the correction. All nine existing desktop release
tests passed, including refusal when each required secret is absent.

The live sweep reproduced seven passes, two failures, and one credential-gated
skip. The failures were the anonymous API rejection cache and document cache.
The document-cache group also carries RSC and markdown negative controls. The
September 6, 01:15 UTC scheduled run passed all three canonical HIT checks and
failed only because an `RSC: 1` request for `/docs/documentation` received
`text/html` ([run 34003400437](https://github.com/koala73/worldmonitor/actions/runs/34003400437)).
A purge does not address that shape, and it passed again on a later probe, so
treat it as a separate negotiation issue rather than evidence against the
corrections above.
Production acceptance remains incomplete until the operational corrections above
are applied and the unchanged live assertions pass.
