---
title: Agent discovery and error responses across Cloudflare and Vercel
date: 2026-09-05
category: integration-issues
module: Agent discovery
problem_type: integration_issue
tags: [orank, cloudflare, markdown, api-errors]
---

# Agent discovery and error responses across Cloudflare and Vercel

The September 5, 2026 orank result was 96/100. Live checks confirmed that `/?mode=agent` already returned the expected JSON. The REST schema contract checks passed. World Monitor has no GraphQL API. A firewall 403 on `/api/graphql` does not establish that an authenticated GraphQL service exists.

The remaining request paths cross two deployment systems.

- Vercel middleware routes the declared AI User-Agents to `public/home.md`. It preserves JSON agent mode, browser HTML, variant hosts, and dashboard links. The response disables caching and declares `Vary: User-Agent`.
- Cloudflare can serve cached homepage HTML before Vercel middleware runs. Cloudflare does not use `Vary: User-Agent` as a cache key. Since #7804 the one managed document rule in `scripts/cloudflare-cache-rule.mjs` carves the declared agents out of its `/` claim, so their requests fall through to the zone's bypass and reach middleware. The separate UA-keyed bypass this script used to append after the homepage cache rule is retired there; `cloudflare-agent-readiness.mjs` now manages the firewall block responses only.
- The Cloudflare rules `Block API Bots` and `Block Scriptlike UAs` return HTML before API handlers run. Both need custom JSON block responses. The change preserves their expressions, actions, order, and existing authentication exceptions.

The shared User-Agent list and denial body live in `shared/agent-request-policy.json`. Public Markdown files carry title, description, and canonical metadata. Generated Markdown documents carry title and canonical metadata. Metadata dates are omitted because a request date does not establish when source content changed.

All 90 original Markdown links in `llms.txt` were checked with redirect-following GETs and body inspection. El País resolved in that run. Two press sites and npm blocked automated requests, while the documentation MCP transport returned a protocol-level 405 to GET. The index now points to the first-party identity document, CLI guide, and documentation MCP server card. Press citations and transport addresses remain available in those documents.

## Prepare the Cloudflare change

Set exactly one of `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ALL_ACCESS_TOKEN`. Use a token scoped to the WorldMonitor zone with WAF and cache-rule edit permissions. The script can load these names through the standard `loadEnvFile()` path. No credential belongs in the plan or Git.

```sh
node scripts/cloudflare-agent-readiness.mjs --plan
node scripts/cloudflare-agent-readiness.mjs --check
```

`--plan` reads the live zone and prints the proposed per-rule changes. `--check` exits nonzero while changes remain. Both are read-only. Review the plan before applying it.

## Deploy and verify

After approval, apply the Cloudflare changes before deploying the origin change. This order prevents cached HTML from hiding the new Markdown response. The homepage carve-out for the declared agents is part of the document cache rule, so it is applied with that script; carving the agents out early only reduces caching for their homepage requests.

```sh
node scripts/cloudflare-cache-rule.mjs --apply
node scripts/cloudflare-agent-readiness.mjs --apply
node scripts/cloudflare-agent-readiness.mjs --check
```

`--apply` changes production Cloudflare configuration. It patches individual rules, stops if the rules change after planning, and verifies the result. It does not replace a ruleset. After the normal origin deployment, run the live response checks.

```sh
node scripts/verify-agent-readiness.mjs https://www.worldmonitor.app
curl -sS -X POST https://ora.ai/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"worldmonitor.app"}'
curl -sS https://ora.ai/api/score/worldmonitor.app
```

The response checker performs public GETs only. A local test pass does not prove Cloudflare activation, Vercel rewrite behavior, or a new orank score. The scan endpoint can return a cached result; compare the response timestamp and cache fields before claiming an improvement.

Cloudflare documents [custom JSON block responses](https://developers.cloudflare.com/waf/custom-rules/create-api/) and [per-rule updates](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/). The update API requires the full retained rule definition even when only the response body changes.

## Firewall delivery gap observed on September 6

The origin change and the firewall configuration have separate delivery paths.
PR #7742 merged at `2026-09-05T18:15:08Z`; its delivery notes explicitly said
Cloudflare had not been changed. The successful Vercel Production deployment
`6295532865` at `2026-09-06T16:53:52Z` used commit
`800289c96b2c296893326dd3f54d9ecd6de25e77`, which includes that change.
The [production sweep](https://github.com/koala73/worldmonitor/actions/runs/34046902572)
then passed ten checks. Its nine required probe groups did not include API
User-Agent denials. The standalone readiness checker was not part of that run.

A read at `2026-09-06T16:56:15Z` confirmed zone `worldmonitor.app`
(`975604917ef222f519dfd394530c3acf`) and custom firewall ruleset
`99b7a9eb61264b0bb276f835a65aa95d`, version `37`. The ruleset was last updated
on July 6, before the merged fix. Neither block rule had `action_parameters`.
The current state therefore supports an unapplied firewall change, rather than
a subsequent overwrite. The authoritative desired response remains
`shared/agent-request-policy.json`, applied by `cloudflare-agent-readiness.mjs`.

| Rule | ID | Version / last update | Matching probe evidence |
| --- | --- | --- | --- |
| Block API Bots | `e2f695f6f65d48c6b524acea358211ac` | 5 / July 6 | `curl/8.7.1`, ray `a36f0269dfe09244` |
| Block Scriptlike UAs | `9f0b4d895ea642d99da7f7be6e55917e` | 2 / March 20 | `ora-agent`, rays `a36f02690f1e9244`, `a36f026c19d39244` |

Cloudflare security events matched those exact request rays to `block` actions
from `firewallCustom`. Thus these are the effective rules, not merely matching
names. Account audit-log access returned HTTP 403 / code 10000. Historical actor
identities, external writers and any attempted applies to other targets could
not be established. Repository inspection found the planner as the explicit
writer of these responses, with no workflow invoking its apply operation. This
does not prove that no external writer exists. The document cache rule has a
separate owner and must not be reapplied as part of this firewall repair.

Redirect-following GETs at `16:56:49–16:56:53 UTC` tested both apex and www,
both `/api/agent-readiness-missing-endpoint` and `/api/graphql`, and all three
User-Agents. The eight denied cases returned HTML 403; the four descriptive-UA
controls returned JSON 404 with `error.code: not_found`, message and hint. Apex
resolved to www. On the API host, the public China decision signals RPC returned
JSON 200 and anonymous ACLED remained JSON 401. These are baseline observations,
not acceptance of the firewall repair.

## Required recurring acceptance

The existing `live-api-cache-auth.yml` sweep now requires `agent-api-errors` in
addition to its cache/auth probes: eleven passes and every named completion
marker. The added group performs the twelve GETs above against fixed apex and
www production targets, follows redirects, checks exact 403/404 statuses, and
compares denial fields with the shared policy. Each sample logs time, final URL,
status, Content-Type, edge request identifiers and a bounded body excerpt under
`LIVE_AGENT_API_RESPONSE`. HTML, an incomplete error or a missing probe fails
the existing Actions job. No new credentials or alert service are required.

The sweep retains successful Vercel Production deployment events and its
six-hour schedule (`00:47`, `06:47`, `12:47`, `18:47` UTC, subject to Actions
scheduling delay). Deployment runs check out the deployed SHA; scheduled runs
use the scheduled revision. A probe-only merge can be excluded by the Vercel
build filter. In that case, wait for a successful normal Production deployment
that includes the probe; do not count a manual checker as a deployment run.

After owner approval, use the existing firewall planner to apply only the two
response additions. Save the live ruleset, cache ruleset and per-rule plan first.
Re-read before each write and stop on concurrent drift. Run `--check` afterwards:
it must report `ready: true` and `changes: []`. Compare retained rule definitions,
order, authentication exceptions and the cache ruleset with the snapshot.

For rollback, re-read the current rule and confirm its response still equals the
response this operation installed. Restore only the prior `response` property
inside the current `action_parameters`, retaining any concurrent unrelated
parameters. Both inspected rules originally lacked that property; remove the
installed response (and send an empty parameters object if no parameters remain).
Patch the full retained current rule definition without server-managed
`id`, `version` or `last_updated`. Stop for owner review if the response itself
has changed. Verify the restored response and repeat the same control probes.
Rollback is a production write and uses the same authorization gate.

Keep the issue open until a real post-deployment sweep and a later scheduled
sweep both pass the matrix. Record their run URLs, times, deployed revision,
rule revision and no-drift result in the owner's acceptance checkpoint. Merge,
configuration activation and production acceptance are separate gates.

After those gates, coordinate one forced Ora scan with the owner of #7818:
`npx ax audit worldmonitor.app --force --json`. Retain `servedFromCache`,
`scannedAt`, `generatedAt`, `analysisStatus`, `pendingChecks` and the individual
JSON-error result. Poll the cached result if analysis is pending; do not spend
another forced scan. An unavailable scan is unavailable secondary evidence.
