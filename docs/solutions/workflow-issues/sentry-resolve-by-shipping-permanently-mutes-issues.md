---
title: Resolve-by-shipping silently mutes browser Sentry issues forever
date: 2026-09-07
category: workflow-issues
module: sentry-triage
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "Issues show status resolved and keep recurring, because the GitHub integration pinned them inRelease to a commit SHA that the stable browser semver release can never exceed"
  - "A commit message that only quoted the resolving marker while explaining the bug pinned a live issue inCommit, with no code-fence or quoting exemption"
  - "The repo's own sentry-triage skill taught the pin-creating commit convention as doctrine"
  - "An issue pinned inRelease with an actor in statusDetails, from a Resolve in release click in the UI rather than from any commit, which no commit-message grep or integration setting can prevent"
root_cause: config_error
resolution_type: tooling_addition
related_components: [tooling, documentation]
tags: [sentry, resolve-by-shipping, inrelease-pin, github-integration, commit-message, observability, muted-issues, sentry-triage]
---

# Resolve-by-shipping silently mutes browser Sentry issues forever

## Release alignment update — 2026-09-08

The owner chose to preserve GitHub/Sentry automation. The older recommendation
below to disable commit resolution is superseded. No such control was found in
the installed integration settings; GitHub issue-status synchronization is a
separate setting. Do not disable the integration or replace it with manual triage.

`shared/sentry-build-metadata.ts` now supplies the deployment SHA as `release`
for production dashboard and marketing events, matching `api/_sentry-common.js`.
Both Vite uploaders use that same release and `dist`. `app_version` retains the
semantic version for searches across deployments; release health is now per SHA.
Missing or malformed production build markers retain the semver fallback.

Preview and development browser events retain build/version tags but omit release
and dist, and use environment-specific fingerprints even for custom groups.
This keeps them out of production release ordering and issue regression state.
Both uploaders disable automatic release injection; the SDK sets production
release metadata explicitly. Build-time `create: false` alone is insufficient
because an event carrying a release can create that release during ingestion.

The marketing build only uploads artifacts. The production root build owns
release creation, finalization, and automatic commit association. Preview and
local builds do not perform those release lifecycle writes. Source-map matching
still uses debug IDs, and the existing public-map cleanup remains in place.
Production build finalization is not proof of a successful deployment: a failed
deployment after the build can still leave a Sentry release behind. This change
does not introduce a post-deployment finalization service.

### Live acceptance after deployment

Local tests prove identity propagation, not Sentry's hosted regression behavior.
The release owner must record the following evidence before calling #7838 closed:

1. Read the production build SHA and inspect a new dashboard event and marketing
   event. Both must carry that SHA as `release` and `dist`, and the expected
   `app_version` and `build_sha` tags. Inspect each event's full stack to confirm
   that uploaded source maps still produce original file names and lines.
2. In an explicitly authorized isolated Sentry test project, reproduce the same
   error fingerprint in release A, then associate its fixing commit with release
   B using the GitHub integration. Confirm the resulting resolution from an
   independent issue read. Use the same configuration and release lifecycle as
   production; a direct status write does not prove commit resolution works.
3. Send an event from A after resolution and record whether it stays resolved.
   Then send the same fingerprint from a later release C and confirm the issue
   reopens. Include a client still running the old semver bundle in the old-build
   check. Do not infer release ordering from the lexical order of SHA strings.
4. Verify preview events have no release and group separately from production,
   and preview builds do not associate resolving commits. Audit any historical
   pin against actual deployed releases; alignment does not repair existing pins
   or issues with missing release metadata by itself.

Keep the daily pin audit as a strict migration review alarm until these checks
pass. Its nonzero result means compatibility needs review, not that every pin is
invalid. Do not automatically clear valid commit/release resolutions. After live
acceptance, replace the blanket pin gate and old plain-only triage guidance with
an evidence-based compatibility policy; do not silently disable the audit.

If new events lose build attribution or mapped frames, stop rollout and restore
the prior build configuration. A rollback restores the old release mismatch, so
the audit and explicit repair of confirmed incompatible pins remain necessary.

The remaining sections record the original incident and remediation.

## Problem

WorldMonitor's documented triage doctrine was resolve by shipping. Put a `Fixes` marker naming a Sentry short ID in the commit message or the PR body and let the Sentry GitHub integration close the issue. The integration does not issue a plain resolve. It resolves the issue `inRelease: <commit-sha>`.

Sentry reopens a release-pinned issue only when an event arrives in a release **newer** than the pin. WorldMonitor's two instrumented surfaces do not agree on what a release is.

The browser bundle keeps a stable semver release and carries the SHA beside it. `src/bootstrap/sentry-build-metadata.ts:22` builds the release as `worldmonitor@${appVersion}`, `package.json:4` pins that version at `2.10.0`, and the commit SHA goes to `dist` at `sentry-build-metadata.ts:28` plus a `build_sha` tag at `sentry-build-metadata.ts:31`. Every browser event therefore lands in `worldmonitor@2.10.0`.

The server and edge surface does the opposite. `api/_sentry-common.js:104` sets `release: process.env.VERCEL_GIT_COMMIT_SHA`, so those events land in SHA-named releases and do order correctly against a SHA-named pin.

The integration invents a third thing. It creates a release object named after the commit SHA, and browser events never belong to it. A browser event can never outrank the pin, so the issue can never reopen. It reads resolved forever while the bug keeps firing.

**The integration is not the only source of a pin.** Choosing "Resolve in release" in the Sentry UI pins the issue to whatever release Sentry considers current, which on this project is a SHA-named server release. The result is byte-identical in effect to the integration's pin and equally unsatisfiable for a browser issue. The two are told apart by `statusDetails.actor`: a UI resolve carries the resolving user, the integration's does not. Any statement that the dashboard toggle alone prevents this class is wrong.

`sentry-build-metadata.ts` is not the bug. Release-plus-`dist` is a coherent, documented, deliberate choice, and the file comment at `sentry-build-metadata.ts:13` states the reason. The defect is that auto-resolve-on-commit assumes a release model the browser bundle does not use.

There is a sharper sub-trap. A commit message that merely **quotes** the marker while explaining the defect still fires it. Sentry matches keyword-plus-short-ID anywhere in a commit message or a PR body. Backticks, code fences, and surrounding prose do not escape it. File content is not scanned, so the same characters are safe inside a source file or a markdown doc. Only commit messages and PR bodies are parsed.

## Symptoms

- The resolved board carried 253 issues across 3 pages on 2026-09-07. Exactly 3 had a non-empty `statusDetails`, all of kind `inRelease`. Those were WORLDMONITOR-122, WORLDMONITOR-11X, and WORLDMONITOR-11Y. The other 250 were exactly `{}`.
- Two of the three had been re-pinned to SHAs newer than the ones the origin issue recorded. The defect recurs on every qualifying merge rather than sitting static.
- A pinned issue shows as resolved in every Sentry view and in every triage sweep while new events keep arriving underneath it. Nothing surfaces the mute.
- During this very fix, a commit body containing the pattern inside backticks, in a sentence describing the defect, pinned a live issue `inCommit` to that commit. The issue was an `Uncaught ConvexError: {"kind":"DODO_PORTAL_ERROR"}` with 4 events across 3 users, last seen 2026-08-21. It had previously been a clean plain resolve.
- A second reading of the board later on 2026-09-07, after PR #7839 merged, found **two** pins rather than the three the origin issue recorded, and they had two different causes. WORLDMONITOR-122 was pinned `inRelease` to `6dc2b6324a` **with** an `actor`, and that commit's body contains no marker at all, so it came from a UI resolve. The `DODO_PORTAL_ERROR` issue was pinned `inCommit` to `6507787e7f` with **no** `actor`, and that SHA exists on no branch in the repo. The other two issues from the origin list were no longer pinned. The population moves between readings, so a pin list is only ever true at the moment it was read.

## What Didn't Work

**Writing `status=resolved` over an already-resolved issue.** The API returns HTTP 200 and silently no-ops. The pin stays. Trusting that response would have reported three repairs that never happened.

**Widening the query window to see more of the board.** `statsPeriod` accepts only `''`, `24h`, and `14d`. Both `30d` and `90d` return HTTP 400 `Invalid stats_period`. All three accepted values return the same 253 issues, so the parameter gates the per-issue stats series, not the population.

**Following `Link: rel="next"` until it disappears.** The `rel="next"` entry is present on the last page too, carrying `results="false"`. A pager that reads only `rel` loops forever.

**Using the token already in `.env.local`.** That is a `sntrys_` release-scoped upload token for source maps. It returns 403 on the issues endpoint regardless of which project it was minted for. Reading issues needs a `sntryu_` user token with `event:read` and `project:read`.

**Testing `statusDetails` for emptiness.** A pinned row also carries an `actor` object, so emptiness is a proxy for the pin, not the pin itself. The moment Sentry attaches `actor` to plain resolves as well, an emptiness test flags all 250 clean rows. Archived issues break it from the other direction. `archived_until_condition_met` legitimately populates `{ignoreCount, ignoreWindow}`, while `archived_forever` and `archived_until_escalating` both report `statusDetails: {}`. Archive mode lives in `substatus`, not in `statusDetails`.

**The old acceptance line in the triage skill.** It forbade only `inNextRelease`. Three `inRelease` pins sat muted while the skill's own acceptance check reported a pass.

## Solution

**Repair each pinned issue through a status transition.** A resolved-to-resolved write no-ops, so the status has to leave `resolved` and come back. Read every step back rather than trusting the write response.

```bash
# 1. Drop the pin by leaving the resolved state.
curl -sS -X PUT "https://us.sentry.io/api/0/issues/$ISSUE_ID/" \
  -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"unresolved"}' >/dev/null

# 2. Confirm the transition landed.
curl -sS "https://us.sentry.io/api/0/issues/$ISSUE_ID/" \
  -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" | jq '.status'

# 3. Resolve plainly, with no statusDetails.
curl -sS -X PUT "https://us.sentry.io/api/0/issues/$ISSUE_ID/" \
  -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"resolved"}' >/dev/null

# 4. Confirm the pin is gone. Expect {}.
curl -sS "https://us.sentry.io/api/0/issues/$ISSUE_ID/" \
  -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" | jq '.statusDetails'
```

This sequence was run against WORLDMONITOR-122, WORLDMONITOR-11X, and WORLDMONITOR-11Y. All three came back with `statusDetails` empty.

**A read-only audit that finds the next one.** `scripts/audit-sentry-resolve-pins.mjs` pages the resolved board and classifies each row on which pin key `statusDetails` carries. `PIN_KINDS` at `scripts/audit-sentry-resolve-pins.mjs:77` names `inRelease`, `inNextRelease`, and `inCommit`. `classifyResolution` at line 107 returns the first key present and `plain` otherwise. `auditResolvedIssues` at line 119 rejects a non-array payload outright, skips rows whose `status` is not `resolved` at line 131, and reports the rest. Nothing in the script mutates Sentry. `formatRepairRecipe` at line 171 prints the transition sequence next to the findings.

The script hard-codes the three API traps. `issuesUrl` at line 205 sends `statsPeriod=''`. `parseLinkHeader` at line 95 requires both `rel="next"` and `results="true"` before it returns a cursor. `fetchResolvedIssues` at line 231 turns a 403 into an error message that names the `sntrys_`-versus-`sntryu_` token distinction instead of a bare status code.

Run it locally.

```bash
SENTRY_AUTH_TOKEN=sntryu_... npm run audit:sentry-resolve-pins
```

**Tests.** `tests/sentry-resolve-pins.test.mjs` holds 17 tests. Verified with `node --test tests/sentry-resolve-pins.test.mjs`, 17 pass, 0 fail.

**A daily job.** `.github/workflows/sentry-resolve-pin-audit.yml` runs on cron `17 6 * * *` plus `workflow_dispatch`. The step at line 30 fails loudly when `SENTRY_AUTH_TOKEN` is absent instead of skipping. That secret was added on 2026-09-07 and the workflow was confirmed green on demand in run 34131150896, so the daily job now reads the real board.

**Doctrine correction.** `.agents/skills/sentry-triage/SKILL.md:40` now states plain resolve only and names all three pin kinds. Line 119 records that the integration currently resolves `inRelease: <commit-sha>` and that no browser event can outrank it.

**Attribution.** `us.sentry.io` is now an `excluded` entry in `PROVIDER_OVERRIDES` at `scripts/source-attribution.mjs:764`, matching the `api.axiom.co` precedent above it, so the error-tracking vendor does not enter the published provider count.

This work is PR #7839, merged 2026-09-07.

## Why This Works

The transition works because the pin lives in `statusDetails` and Sentry only recomputes `statusDetails` on a real status change. Leaving `resolved` clears it. Returning to `resolved` with no `statusDetails` in the body produces a plain resolve.

Classifying on the pin key rather than on emptiness ties the audit to the thing that actually mutes an issue. A pinned row is pinned because `statusDetails.inRelease` exists, not because the object is non-empty. The audit survives Sentry attaching new metadata to clean resolves, and it does not misread an intentional `archived_until_condition_met` window as a pin.

Skipping rows whose `status` is not `resolved` keeps that guarantee even when the `is:resolved` query returns something else. The audit trusts the row, not the query string.

Failing on an empty board closes the last hole. A wrong org, a wrong project, or a token that cannot see the project all return an empty list, which is indistinguishable from a clean board. `assertLiveBoardIsNotEmpty` at `scripts/audit-sentry-resolve-pins.mjs:183` throws on that shape. An audit whose broken state looks like its passing state protects nothing.

Only the short ID, permalink, pin kind, and sanitized pin value reach the report. A pinned `statusDetails` embeds an `actor` object carrying the resolver's email, gravatar URL, `dateJoined`, and `lastLogin`. Any tool that dumps `statusDetails` raw leaks that into CI logs.

## Prevention

**Plain resolve only.** Never resolve into `inRelease`, `inNextRelease`, or `inCommit`. Read `statusDetails` back after every resolve and confirm it carries none of those three pin keys. Assert on the pin keys, not on the object being empty, for the reason given in What Didn't Work. Do not trust the write response, because a resolved-to-resolved write returns 200 without changing anything.

**Scan commit messages before pushing.** A keyword adjacent to a `WORLDMONITOR-` token fires the integration anywhere in a commit message or a PR body, including inside backticks and code fences.

```bash
git log <base>..HEAD --format=%B \
  | grep -Eio '(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)[[:space:]]+WORLDMONITOR-[A-Z0-9]+'
```

Any hit means rewrite the message before the branch is visible. Put the short ID and the keyword in separate sentences, or drop the keyword. After rewriting, confirm the tree is byte-identical with `git diff <old-sha> HEAD` returning empty, then force-push. File content is never scanned, so the same text is safe in a source file or a doc.

**Audit the board on a schedule and on demand.**

```bash
npm run audit:sentry-resolve-pins
```

It exits non-zero and emits a `::error::` line per pinned issue. The daily workflow runs the same command.

**This is a recurring failure mode, not a one-off.** Issue #6367 recorded the same class on 2026-08-09, when 21 issues sat muted behind `inNextRelease` pins and 6 were still firing, one of them at 357k events. That incident is why the triage skill's acceptance line named `inNextRelease` specifically. Naming one pin kind is what let three `inRelease` pins pass the same check a month later. The fix is to assert on the full set of pin keys, which is what `PIN_KINDS` now enumerates. Do not assert instead that `statusDetails` is empty: that is the proxy rejected in What Didn't Work, and an archived issue or a future `actor` on a clean resolve both defeat it.

**One gap remains open, and it only covers half the class.** Turning off resolve-on-commit in the Sentry GitHub integration dashboard is the only change that prevents rather than detects, and it prevents only the integration half. It was still not done as of 2026-09-07, and it is a dashboard setting, so no check in this repo can confirm its state.

The other half has no preventive control at all. A human choosing "Resolve in release" in the Sentry UI pins the issue with no commit, no PR, and nothing for a pre-push grep to scan, and that is how the worst of the two 2026-09-07 pins was created. For that half the daily audit is the only control that exists, which makes it load-bearing rather than a backstop. Treat a red `audit:sentry-resolve-pins` as a real incident, and keep its credential alive.

## Related Issues

- Origin issue #7838 and the fix PR #7839, merged 2026-09-07.
- Issue #6367, the 2026-08-09 `inNextRelease` incident of the same class.
- Issue #7833, the downstream code fix for WORLDMONITOR-122, which is the real bug that a permanent mute would have hidden.
- [Sentry noise filtering with stack gating and signature matching](../best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md), one of the two canonical triage write-ups.
- [A name-shaped trampoline allowlist cannot match a nameless frame](../logic-errors/name-shaped-trampoline-allowlist-cannot-match-a-nameless-frame.md), the other canonical write-up, which shares the lesson that the real runtime representation beats the assumed one.
- [Convex auth drift ramp was a stacked Clerk token cache](../integration-issues/convex-auth-drift-ramp-was-stacked-clerk-token-cache.md), which explains this repo's Sentry `release` tag semantics.
- [Mint failed named a mint nobody attempted](../logic-errors/mint-failed-named-a-mint-nobody-attempted.md), the same read-the-state-back discipline applied to telemetry tagging.
