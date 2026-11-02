---
title: A fail-closed feature shipped dead because its env var was never set in production
date: 2026-11-01
category: integration-issues
module: agent-feedback
problem_type: integration_issue
component: development_workflow
symptoms:
  - "report_issue (MCP) refuses every report with 503 \"Feedback is temporarily unavailable.\" right after deploy"
  - "CI, tests and tools/list are all green; only a real write fails"
  - "MCP usage telemetry logs the refusal as reason=rate_limit_degraded, which reads as a limiter outage"
root_cause: incomplete_setup
resolution_type: environment_setup
severity: high
related_components: [authentication, background_job]
tags: [env-vars, vercel, fail-closed, usage-ua-pepper, agent-feedback, axiom, deploy-verification]
---

# A fail-closed feature shipped dead because its env var was never set in production

## Problem

Agent feedback (#8721) went live with every report refused. `submitAgentFeedback` will not store a report without a pepper for its IP and user-agent hashes (threat model Decision 8), and `USAGE_UA_PEPPER` had never been set in Vercel production. The threat model assumed the pepper was already in use, because `deriveUaHash` reads the same variable. Nobody checked.

## Symptoms

- A live `report_issue` call returned HTTP 503 with `Feedback is temporarily unavailable.`
- The Axiom usage row for that call said `status=503 reason=rate_limit_degraded`. MCP dispatch maps every 503 to that reason (`api/mcp/usage.ts:258-261`), so the row pointed at the limiter instead of the config.
- Nothing failed before the first real write. Unit tests stub the env, and tools/list only shows the tool is registered.

## What Didn't Work

- **Reading the usage reason.** `rate_limit_degraded` covers any dispatch 503, so it can't tell a missing pepper from an unreachable limiter or store.
- **Assuming the Convex side was missing.** Convex deploys separately from Vercel, so it was a fair suspect, but the routes were live (see the probe below).

## Solution

The 503 has three possible sources, all in `server/_shared/agent-feedback.ts`: no pepper (line 500), a failed Convex call, or a refused admission. Rule them out from the outside, without credentials where possible:

1. **Convex routes.** POST to the HTTP route with no secret. A deployed route returns 401; an unknown route returns 404. `/api/internal-find-feedback-retry` and `/api/internal-submit-feedback` both returned 401, so they were deployed.
2. **Vercel env names.** Link the CLI outside the repo and list names only (values are encrypted or hidden):
   ```bash
   vercel link --cwd <scratch-dir> --scope eliewm --project worldmonitor --yes
   vercel env ls --environment=production --cwd <scratch-dir> --scope eliewm | grep USAGE_UA_PEPPER
   ```
   It returned nothing.
3. **A telemetry field the same variable feeds.** `deriveUaHash` returns null without the pepper (`server/_shared/usage.ts:500-502`). An Axiom query for `ua_hash` on `wm_api_usage` failed with `invalid field "ua_hash"`, because Axiom only knows fields it has ingested. Counting with `column_ifexists('ua_hash', '')` gave 0 of 75.7M rows over 30 days.

The two independent signals agreed. The fix was a config change:

```bash
openssl rand -hex 32 | tr -d '\n' | vercel env add USAGE_UA_PEPPER production --sensitive --cwd <scratch-dir> --scope eliewm
```

Vercel applies an env change only to deployments created after it. Two production builds from main were already queued, so a manual redeploy would have been replaced when they finished. The next production deployment created after the change picked up the pepper.

Verified in production: an anonymous `report_issue` call was stored, `node scripts/triage-agent-feedback.mjs list --join` showed it joined to its Axiom row, and the row was dismissed with `dismiss <id> --reason "deploy verification"`.

## Why This Works

Failing closed was the design: with no pepper, the store refuses rather than writing unpeppered or null hashes. The defect was the missing setup step, not the code. The same missing variable had also left `ua_hash` out of every usage row for at least 30 days. No one noticed, because a null field produces no error.

## Prevention

- **Before merging a feature that reads `process.env.X` behind a fail-closed branch, confirm X exists in production.** Use `vercel env ls` (names only). If X already feeds a telemetry field, check that the field is populated.
- **Do not let a design doc assume shared config is set.** When a doc says another module "already uses" a variable, verify that it is set in production, not just that the code reads it.
- **Make a live write part of acceptance.** CI and tools/list cannot catch this. One real request through the deployed path can.
- **Expect env changes to wait for the next deployment.** Check `vercel inspect <domain>` to see which deployment serves production, and make sure it was created after the change.

Related: `docs/solutions/design-patterns/closed-world-classification-gate-for-config-completeness.md` covers the build-time version of this failure (a `VITE_*` var missing from the desktop build). This doc covers a server secret missing from production.
