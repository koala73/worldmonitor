---
title: Cloudflare rate limit 10429 on the Worker deploy masked a deleted CLOUDFLARE_API_TOKEN
date: 2026-11-05
category: integration-issues
module: ci-deploy-worker
problem_type: integration_issue
component: tooling
symptoms:
  - "Post-merge Deploy Monitor reports Deploy api-cors-preflight Worker [RUN_FAILED]"
  - "wrangler deploy logs Rate limited. Please wait and consider throttling your request speed [code: 10429]"
  - "The continue-on-error Set Axiom secret step logged Authentication error [code: 10000] and Invalid access token [code: 9109] seconds earlier"
  - "gh run view --log-failed shows only the failing Deploy step, not the secret-put step"
  - "After re-setting the secret, Invalid format for Authorization header [code: 6111]"
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - development_workflow
tags: [cloudflare, wrangler, github-actions, secrets, continue-on-error, deploy-monitor, api-cors-preflight, rate-limit]
---

# Cloudflare rate limit 10429 on the Worker deploy masked a deleted CLOUDFLARE_API_TOKEN

## Problem

The Post-merge Deploy Monitor went red on 2026-11-05 because the api-cors-preflight Worker deploy (`.github/workflows/deploy-worker.yml`) failed twice on `main`. The visible error was a Cloudflare rate limit, so PR #10178 added a retry wrapper. The real cause was a deleted `CLOUDFLARE_API_TOKEN` repo secret. Production stayed on the 2026-11-01 Worker, so #9881's `Allow` header change never shipped until the token was replaced.

## Symptoms

- Post-merge Deploy Monitor run 41992513751 reported `Deploy api-cors-preflight Worker [RUN_FAILED] run 41988326131 concluded failure`.
- The Deploy step of runs 41960944579 (03:20Z) and 41988326131 (07:36Z) logged `Rate limited. Please wait and consider throttling your request speed [code: 10429]`.
- After #10178, the wrapper retried three times on 10429 and then the fourth attempt showed a different error: `Authentication error [code: 10000]` followed by `Invalid access token [code: 9109]`.
- The "Set Axiom secret" step in both runs had already failed on its very first Cloudflare call with the same 10000 and 9109 codes. The job stayed green at that point because the step runs with `continue-on-error: true` (`.github/workflows/deploy-worker.yml:85` on `main`).
- `gh secret list` showed the secret last set on 2026-05-27. The last green deploy was 2026-11-01 15:15Z.

The misleading tail versus the real first failure, from run 41988326131:

```
# Deploy step (what --log-failed shows)
cf-rate-limit-retry: Cloudflare API rate limited (10429); retrying in 15s (attempt 2 of 4)
...
  Authentication error [code: 10000]
  Invalid access token [code: 9109]

# "Set Axiom secret" step, ~2 s earlier (continue-on-error, hidden by --log-failed)
🌀 Creating the secret for the Worker "api-cors-preflight"
✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/scripts/api-cors-preflight/secrets) failed.
  Authentication error [code: 10000]
✘ [ERROR] A request to the Cloudflare API (/accounts) failed.
  Invalid access token [code: 9109]
```

## What Didn't Work

- **Diagnosing from `gh run view --log-failed`.** That view prints only steps that failed the job. The step that failed first was `continue-on-error`, so it did not count as failed and its auth errors did not appear. The retry wrapper in #10178 (`scripts/cf-rate-limit-retry.mjs` on `main`) was written from this truncated view. It matches only `[code: 10429]` (`scripts/cf-rate-limit-retry.mjs:16`) and exits immediately on anything else (`scripts/cf-rate-limit-retry.mjs:66`), so it did exactly what it was built to do and could not help.
- **Treating 10429 as the root cause.** Cloudflare rate-limits repeated failed authentication. The 10429 was downstream of the invalid token. Run 41960944579 shows the same order: 10000, 9109, then 10429.
- **Looking for an expired token to roll.** The Cloudflare profile token list, sorted by last used, had nothing between "3d ago" and "2mo ago". A token last used by CI on 1 Nov would have sat in that gap. The token had been deleted, not expired. Both Cloudflare tokens in the local `.env.local` were also invalid.
- **Reading the token list with the browser CLI.** dash.cloudflare.com loops the automated browser on a Turnstile challenge. The user's screenshot was the only way to see the list.
- **The first `gh secret set`.** The re-run after the first update failed instantly with `Authentication failed (status: 400) [code: 9106]` and `Invalid request headers [code: 6003] - Invalid format for Authorization header [code: 6111]`. Cloudflare rejected the header before checking the token, which means the stored value contained bytes that cannot go in an HTTP header, typically a trailing newline or quotes from the paste. The second update with the same token scopes worked.

## Solution

1. Create a new Cloudflare user token on the account that owns the Worker and the worldmonitor.app zone, with two policies:

```
Policy 1  Entire Account         Workers Scripts: Write
                                 Workers KV Storage: Read
Policy 2  Specified Domains      Workers Routes: Write
          worldmonitor.app
```

   The KV read is for the `BOOTSTRAP_KV` binding in `workers/api-cors-preflight/wrangler.toml`. The zone-scoped Workers Routes write is what binds `api.worldmonitor.app/*`; its absence kept this same workflow red on every run from 27 May to 10 July 2026, until #4651 was resolved (first green run 15 July).

2. Store it as the repo secret with exact bytes, no trailing newline:

```
printf '%s' 'PASTE_TOKEN_HERE' | gh secret set CLOUDFLARE_API_TOKEN --repo koala73/worldmonitor
```

   The GitHub UI (Settings → Secrets and variables → Actions → Update) works too. Avoid `echo TOKEN | gh secret set`, which appends a newline.

3. Validate by re-running the failed job and then the monitor:

```
gh run rerun 41988326131 --failed --repo koala73/worldmonitor
gh workflow run postmerge-deploy-monitor.yml --repo koala73/worldmonitor --ref main
```

   Green evidence: run 41988326131 logged `Success! Uploaded secret AXIOM_API_TOKEN`, `Uploaded api-cors-preflight`, and `Deployed api-cors-preflight triggers`; monitor run 42029306753 reported `Deploy api-cors-preflight Worker [DEPLOYED]`.

## Why This Works

The Worker deploy needs one token that can upload scripts, read the KV namespace it binds, and write the zone route. The deleted token had those scopes; the new one restores them. Once Cloudflare accepted the token, there were no failed-auth calls left to rate-limit, so 10429 disappeared on its own. The 6111 failure in between was a storage artifact, not a scope problem, which is why re-pasting the identical token fixed it.

The same secret feeds `.github/workflows/deploy-railway-reconcile-control.yml`, so the replacement also unblocks that Worker's next deploy.

## Prevention

- **Read the whole job log before classifying a wrangler failure.** `--log-failed` hides `continue-on-error` steps. Grep every Cloudflare error code in order:

```
gh run view --job <job-id> --log | sed 's/\x1b\[[0-9;]*m//g' | grep -n 'code: '
```

  If 9109 or 10000 appears before 10429, the token is the problem and no retry will help.

- **Check prior runs of the same workflow first.** `gh run list --workflow "Deploy api-cors-preflight Worker" --limit 10` showed two consecutive failures after a long green streak with no code change to the Worker, which points at infrastructure, not the merged commit.

- **Make the secret-put step fail loudly on auth errors.** It must stay `continue-on-error` so Axiom telemetry can never block the CORS deploy, but an invalid token will also break the Deploy step seconds later, so surfacing it early costs nothing. Suggested change to the `run:` block at `.github/workflows/deploy-worker.yml:90-95` (not implemented as of this writing):

```yaml
run: |
  if [ -n "$AXIOM_API_TOKEN" ]; then
    out=$(printf '%s' "$AXIOM_API_TOKEN" | npx wrangler secret put AXIOM_API_TOKEN 2>&1) || true
    printf '%s\n' "$out"
    if printf '%s' "$out" | grep -Eq 'code: (9109|10000)\]'; then
      echo "::error::CLOUDFLARE_API_TOKEN is invalid or lacks scope; rotate the repo secret"
      exit 1
    fi
  fi
```

  `continue-on-error` keeps the job going, but the `::error::` annotation makes the first failure visible in the run summary.

- **Teach the retry wrapper to stop on auth errors.** Suggested addition to `scripts/cf-rate-limit-retry.mjs` before the rate-limit check at line 66 (not implemented as of this writing):

```js
const AUTH_ERROR = /\[code: (9109|10000|9106|6111)\]/;
// inside the loop, before `if (!RATE_LIMIT.test(output))`
if (AUTH_ERROR.test(output)) {
  process.stderr.write('cf-rate-limit-retry: Cloudflare rejected the API token; rotate CLOUDFLARE_API_TOKEN instead of retrying\n');
  process.exit(code);
}
```

- **Store secrets with `printf '%s'`, never `echo`.** A 6111 "Invalid format for Authorization header" right after a secret update means the bytes are wrong, not the scopes.

- **Rotate the matching local tokens at the same time.** Both Cloudflare tokens in the root `.env.local` were dead in the same window. A deleted CI token usually means an account-level cleanup; verify the local ones with `GET /user/tokens/verify` before the next local wrangler or zone-config task.

## Related Issues

- #10178 added `scripts/cf-rate-limit-retry.mjs` for the 10429 symptom. It is harmless but was built on the wrong diagnosis.
- #9881 (`Allow` header on legacy 405 responses) was the change stranded by the first failed deploy on 2026-11-05.
- #4651 (July 2026): the same workflow was red on every run because the then-current token lacked zone-level Workers Routes:Edit, which left the Worker inert behind Vercel-origin CORS. The policy list above is the complete scope that fixes both failures.
- [The post-merge deploy monitor false-alarmed on a stale GitHub run-listing snapshot](convex-deploy-monitor-outvotes-stale-github-run-listing-snapshot.md): the other way this monitor goes red. That one is a false alarm from GitHub's API; this one is a true positive.
- [Actions cannot open a review PR and the monitor re-alerts after the fix](actions-cannot-open-a-review-pr-and-the-monitor-realerts-after-the-fix.md): a sibling lesson on a verify step that must not run under `continue-on-error`.
