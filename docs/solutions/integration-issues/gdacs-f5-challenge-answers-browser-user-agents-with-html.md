---
title: GDACS's F5 bot defense answers browser User-Agents with an HTML challenge, failing every GDACS event type
date: 2026-11-03
category: integration-issues
module: seed-natural-events
problem_type: integration_issue
component: background_job
symptoms:
  - "naturalEvents health is SEED_ERROR with errorCode GDACS_TYPE_COVERAGE_INCOMPLETE"
  - "Every seed-natural-events run logs '[GDACS] partial coverage' with 'body INVALID_JSON' for EQ, FL, TC, VO, WF and DR"
  - "The failing responses are HTTP 200, content-type text/html, about 5-6 KB"
  - "The map keeps showing GDACS events only while the retained snapshot lasts (9 hours after the last success)"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - natural-events
tags: [gdacs, f5, bot-defense, user-agent, chrome-ua, html-challenge, seed-natural-events]
---

# GDACS's F5 bot defense answers browser User-Agents with an HTML challenge, failing every GDACS event type

## Problem

From 07:30 UTC on 2026-11-03, every GDACS request from `seed-natural-events` got back an HTML page instead of JSON. All six event types failed to parse. Natural events ran on retained GDACS data that would expire at 16:30 UTC, after which only NASA EONET events would remain on the map.

## Symptoms

- `/api/health` reported `naturalEvents` as `SEED_ERROR` with `GDACS_TYPE_COVERAGE_INCOMPLETE`.
- The Railway logs showed `gdacs:<type> body INVALID_JSON`, with `statusCode: 200` and `contentType: "text/html"`, for every type on every run.
- The body was about 5.6 KB. It held F5's JavaScript challenge: `TSPD` markers, `window["bobcmn"]`, a `<noscript>` "Please enable JavaScript" message, and no `<title>`.

## What Didn't Work

- **Assuming a Railway IP block.** The same URL returned JSON from a laptop. That looked like the NRCan Cloudflare case, where Railway's IPs were blocked. But the laptop probe also used a different User-Agent, so it changed two things at once and proved nothing about the IP.
- **Reading the seeder logs for the cause.** The request diagnostics recorded status, content type and byte count, but not the body. The logs alone could not tell a challenge from a maintenance page.

## Solution

Change one variable at a time: same machine, same IP, two User-Agents.

| User-Agent | Response |
|---|---|
| the seeder's `CHROME_UA` | `200 text/html`, 5669 bytes (twice) |
| `WorldMonitor/1.0 (+https://www.worldmonitor.app)` | `200 application/json`, 11787 bytes (twice) |

The response also set a `TS01…` cookie, which is the mark of F5 BIG-IP bot defense. F5 challenges clients that claim to be a browser but cannot run JavaScript. A client that names itself passes.

PR #10101 gives GDACS requests an honest User-Agent. EONET and NHC keep their existing headers. `fetchEventSourceJson` takes a `userAgent` option that defaults to `CHROME_UA`, and `fetchGdacsType` passes the GDACS one:

```js
// scripts/seed-natural-events.mjs
const GDACS_USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
...
const data = await fetchEventSourceJson(`gdacs:${eventtype}`, url.toString(), fetchFn,
  eventtype === 'VO' ? { type: 'FeatureCollection', features: [] } : undefined,
  { attemptTimeoutMs: GDACS_REQUEST_TIMEOUT_MS, budgetMs: GDACS_REQUEST_BUDGET_MS, userAgent: GDACS_USER_AGENT });
```

`tests/natural-events-gdacs-eventtype.test.mjs` has the regression test, "identifies itself honestly so the GDACS bot defense serves JSON". Its stub replays the challenge: a `Mozilla/` User-Agent gets the HTML page, and any other User-Agent gets JSON. The test failed before the change and passes after it.

Verified in production after the merge: the 16:31 and 17:00 UTC runs logged `sourceState="ok"` and `failedSources=[]`, and `naturalEvents` returned to OK.

## Why This Works

The block was keyed on the User-Agent, not on the network. The seeder claimed to be Chrome but behaved like a script, and that mismatch is exactly what browser-challenge bot defense looks for. Sending a named, non-browser User-Agent removes the mismatch. GDACS serves its public API to that client as JSON.

## Prevention

- When an upstream suddenly returns `200 text/html` to a seeder that sends `CHROME_UA`, test an honest User-Agent before suspecting an IP block. Change only the User-Agent, and use the same machine. See [Barchart WAF challenge answers HTTP 202](barchart-waf-challenge-answers-202-and-passes-resp-ok.md) for the WAF case where no header helps.
- A `TS01…` `Set-Cookie`, `TSPD` or `window["bobcmn"]` in the body means F5 bot defense.
- Keep the honest User-Agent per source. Changing the shared `CHROME_UA` for every seeder is a separate, broader change, and each upstream would need its own check.
- Prefer an honest User-Agent to a spoofed one. Tuning a client to pass a browser challenge is circumvention. Identifying the client truthfully is not.
