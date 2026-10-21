---
title: "Brief magazine Umami loader could report the signed Brief URL token"
date: 2026-09-15
category: security-issues
module: server/_shared/brief-render.js
problem_type: security_issue
component: brief_system
severity: medium
symptoms:
  - "UMAMI_LOADER in server/_shared/brief-render.js emitted the abacus.worldmonitor.app/script.js tag with no query-exclusion attribute, rendered into the page head"
  - "the loader's own code comment invited the tracker onto the credentialed brief route, naming the hosted magazine and public-share mirror as intended surfaces"
  - "the only thing blocking the leak was the CSP script-src for /api/brief/(.*) in vercel.json, which omits abacus.worldmonitor.app by accident rather than design"
  - "a Chromium harness with abacus.worldmonitor.app admitted to the CSP recorded one POST to https://abacus.worldmonitor.app/api/send whose payload url field contained the sentinel reader token, actual 1 expected 0"
root_cause: config_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [brief-hmac-token, umami-analytics, query-string-credential, capability-url, csp-defense-in-depth, data-exclude-search, brief-magazine]
---

# Brief magazine Umami loader could report the signed Brief URL token

## Problem

The personal brief magazine is served at `GET /api/brief/{userId}/{issueSlot}?t={token}`, and the HMAC token in `?t=` is the sole reader credential (`api/brief/[userId]/[issueDate].ts:10-13`). The renderer injects the self-hosted Umami tracker into that page, and Umami reports the full page URL including the query string unless the script tag carries `data-exclude-search="true"`. The loader had no such attribute, so any change that let the script run would have written every reader's capability token into the analytics database with every pageview.

## Symptoms

- `UMAMI_LOADER` in `server/_shared/brief-render.js` emitted the `https://abacus.worldmonitor.app/script.js` tag with no query-exclusion attribute, and the rendered page emits it in `<head>` (`server/_shared/brief-render.js:1660`).
- The loader's own comment invited the tracker to run on the credentialed route, describing the hosted magazine and the public-share mirror as intended surfaces (`server/_shared/brief-render.js:1225-1231` before PR #8179).
- The only thing stopping the leak was the Content-Security-Policy for source `/api/brief/(.*)` in `vercel.json:569-572`, whose `script-src` lists `'self' 'unsafe-inline' https://static.cloudflareinsights.com` and omits `abacus.worldmonitor.app`.
- In a Chromium harness with `abacus.worldmonitor.app` admitted to the CSP, one POST reached `https://abacus.worldmonitor.app/api/send` with the sentinel token inside the payload `url` field. Assertion output read actual 1, expected 0. The results file keeps only the post-fix run; the pre-fix number was observed in the session.

## What Didn't Work

- Treating the CSP as the sole intentional control. The CSP lives in `vercel.json`, the loader lives in `server/_shared/brief-render.js`, and the loader's comment argued for exactly the change that would remove that outer fence. The CSP block was a valid defense-in-depth layer, but it was incidental distance rather than deliberate policy next to the emitter.
- Scoping the earlier audit to the named claim. A 2026-09-15 security-validation batch closed the finding `BriefHmacQueryTokenAnalyticsBeacon` as no-change after proving the Cloudflare Web Analytics beacon strips the query, and Cloudflare terminates TLS for `worldmonitor.app` so it already sees the URL. That conclusion was correct for the Cloudflare beacon and said nothing about the Umami loader one line away in the same `<head>`.
- Reusing the audit's harness as written. It imported the renderer from a codex worktree path and only exercised the Cloudflare beacon. Re-pointing it at the current tree and adding the Umami modes is what surfaced the gap.

## Solution

Add the query-exclusion attribute to the loader constant and pin it with a test. Merged in PR #8179 on 2026-09-15 as two commits, the failing test first and then the fix.

Before PR #8179, at `server/_shared/brief-render.js:1232`.

```js
const UMAMI_LOADER = '<script async src="https://abacus.worldmonitor.app/script.js" data-website-id="…" data-domains="worldmonitor.app,…"></script>';
```

After PR #8179, at `server/_shared/brief-render.js:1236`.

```js
const UMAMI_LOADER = '<script async src="https://abacus.worldmonitor.app/script.js" data-website-id="…" data-exclude-search="true" data-domains="worldmonitor.app,…"></script>';
```

The new case in `tests/brief-thread-open-telemetry.test.mjs:233-242` pulls the loader tag out of the rendered magazine and asserts the attribute.

```js
const loader = html.match(/<script[^>]*abacus\.worldmonitor\.app\/script\.js[^>]*>/)?.[0];
assert.match(loader, /\sdata-exclude-search="true"(\s|>)/);
```

The comment above the constant now states that the query carries the sole reader credential and names the route file (`server/_shared/brief-render.js:1232-1235`). No CSP change was made. Whether magazine telemetry should run on that route at all is a separate question.

## Why This Works

The Umami client reads `data-exclude-search` from its own script tag and strips `location.search` from the reported URL only when that attribute is present. The live tracker at `https://abacus.worldmonitor.app/script.js` computes the flag as `j=w("exclude-search")===b` and drops `e.search` inside `B(t)` only when `j` holds. With the attribute in place, the harness mode that admits `abacus.worldmonitor.app` to the CSP still produces one POST, and its payload `url` is `https://worldmonitor.app/api/brief/synthetic_user/2026-09-15-0800` with no query.

The fix also moves the query-exclusion invariant into the same file as the emitter. The renderer now carries the reason in its comment and a test that fails when the attribute is removed. That local control still holds if a future CSP edit admits `abacus.worldmonitor.app`; it does not license opening the brief CSP. Keep abacus out of `/api/brief/(.*)` `script-src` and `connect-src` unless path- and query-credential leak paths are separately proven closed.

## Prevention

- Brief URL (`GET /api/brief/{userId}/{issueSlot}?t={token}`): the HMAC token in `?t=` is the sole reader credential (`api/brief/[userId]/[issueDate].ts:10-13`). A page whose query carries that credential must not load an analytics tracker without query exclusion. Umami's default is to report `location.search`; first-party and self-hosted trackers are not exempt, because the credential lands in a queryable database either way. Keep `data-exclude-search="true"` on `UMAMI_LOADER` next to the emitter, state the reason in the comment, and pin it with a test that fails on removal.
- Public-share mirror (`api/brief/public/[hash].ts`): the credential is the path hash, not the query (`api/brief/public/[hash].ts:12-15`). Optional `?ref=` is affiliate attribution only (`server/_shared/brief-share-url.ts:117-140`). `data-exclude-search` strips search and leaves the path intact, so query exclusion alone does not close a public-share analytics leak. That route shares the same `/api/brief/(.*)` CSP entry and the same loader; path credentials need a different control (omit the tracker, redact or rewrite the path, or keep CSP from admitting `abacus.worldmonitor.app`).
- CSP is a valid defense-in-depth outer fence, not a substitute for a co-located emitter invariant. The `script-src` list in `vercel.json:569-572` blocked the loader while the loader's own comment in `server/_shared/brief-render.js` argued the tracker belonged there — incidental distance, not deliberate policy. Keep both layers: leave abacus out of brief `script-src` and `connect-src` unless path- and query-credential leak paths are separately proven closed, and keep `data-exclude-search="true"` next to `UMAMI_LOADER`.
- When an audit finding is closed as "claim defeated", check the neighbouring mechanisms on the same surface, not only the named one. The `BriefHmacQueryTokenAnalyticsBeacon` closure was right about the Cloudflare beacon and blind to the Umami tag beside it. Make the closing sweep enumerate every mechanism of that class on the page, then state which ones were tested.
- Rerun the evidence harness yourself before trusting a closure. The harness used here is a local Playwright script, not committed. It renders the magazine with `renderBriefMagazine`, serves it at the sentinel URL with intercepted routes, and runs the live tracker fetched from `https://abacus.worldmonitor.app/script.js`. Its three modes are `umami-real-csp` (loader CSP-blocked, 0 posts, 1 violation), `umami-csp-allows-abacus` (the leak case, before the fix 1 POST carrying the sentinel, after the fix 1 POST with no query), and `cf-beacon-real-csp` (control, 2 posts, no token). Local checks are `node --import tsx --test tests/brief-thread-open-telemetry.test.mjs` (23 pass; before the fix the new case is the only failure; without `--import tsx` the dashboard suite cannot resolve `@/utils`, four cases are cancelled, and the run exits 1 while still printing 19 pass), `node --test tests/brief-magazine-render.test.mjs` (91 pass), and `node --import tsx --test tests/brief-edge-route-smoke.test.mjs` (22 pass, the `--import tsx` flag is required or 12 fail on `main` too).

## Related Issues

- PR #8179 carries the fix and the regression test. It merged on 2026-09-15 with 62 CI checks and 0 failures.
- The local batch outcome file `BriefHmacQueryTokenAnalyticsBeacon` (not in the repo) records the earlier no-change closure that this work reopened by scope.
- Sibling follow-ups filed from the same re-validation pass are #8175 (`frame-ancestors *.vercel.app`), #8176 (SECURITY.md pointer and DNS residual), #8177 (YouTube embed parent-origin suffix regex), and #8178 (Clerk `azp` binding backlog).
- [ref param is affiliate attribution, use utm for internal source tags](../conventions/ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md) covers the same tracker fact, Umami reads and reports URL query parameters, from the attribution side.
- [A gate exemption is only as strong as the job that enforces it](../workflow-issues/a-gate-exemption-is-only-as-strong-as-the-job-that-enforces-it.md) is the same structural lesson in CI: a compensating guard that lives somewhere other than the thing it guards.
- [Umami answers HTTP 200 when it drops a bot write](../integration-issues/umami-answers-http-200-when-it-drops-a-bot-write.md) documents the same self-hosted collector from the delivery side.
- `abacus.worldmonitor.app` is self-hosted Umami on our own infrastructure (`docs/privacy.mdx:32` and `docs/privacy.mdx:62`), loaded as a first-party script by the dashboard (`src/services/analytics.ts:51`).
