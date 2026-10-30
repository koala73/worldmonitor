---
module: dependencies
component: npm and pnpm dependency graphs
problem_type: security_issue
tags: [dependabot, undici, miniflare, wrangler, fast-uri, ajv, umami]
---

# Dependabot triage on October 27, 2026

The GitHub API returned 10 open alerts, all raised on October 24. This review uses main commit `09405c989` and Node 24.15.0.

| Alerts | Dependency and graph | Evidence and action |
| --- | --- | --- |
| 473, 476 | undici 7.29.1 in `workers/api-cors-preflight` and `workers/railway-reconcile-control` (GHSA-xjj6-f33q-929c, high) | miniflare pins undici exactly under wrangler 4.150.0 and 4.143.1. Only wrangler 4.153.0, published October 26 on a miniflare beta, moves to 7.30.1. Override undici to 7.30.1 in both workers instead of adopting a one-day-old wrangler. |
| 464–467 | fast-uri 3.1.8 in root (four advisories, low and medium) | ajv 8.20.0 pulls it in, and the root override pins it. Raise the override to 3.1.9. |
| 459–462 | fast-uri 3.1.8 in Umami runtime (same four advisories) | Prisma's ajv pulls it in, and the pnpm override pins it. Raise the override to 3.1.9 and regenerate with pnpm 10.15.1. |

The undici alerts are development scope: wrangler runs only on maintainer machines and in deploy CI, and miniflare is its local simulator. The Umami alerts are runtime scope, but the affected code is URI normalization inside ajv schema resolution. No alert had a demonstrated exploit path. No alert is dismissed.

## Verification

- `tests/dependency-security-regression.test.mjs` adds four lockfile checks. Against main they fail. With this change all 38 tests pass.
- In each worker, a clean `npm ci` resolves undici 7.30.1 and `npm audit` reports 0 vulnerabilities. `wrangler deploy --dry-run` succeeds, and the worker suites pass (71 and 51 tests).
- `wrangler dev --local` for the CORS Worker answers a preflight with 204 and the expected CORS headers through undici 7.30.1.
- ajv 8.20.0 with fast-uri 3.1.9 resolves a relative cross-schema `$ref` and validates correctly.
- Real deploys and the Umami Docker image are unverified.
