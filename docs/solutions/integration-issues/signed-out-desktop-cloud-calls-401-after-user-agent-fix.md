---
title: "Signed-out desktop got a 401 on every cloud call once the User-Agent 403 was fixed"
date: 2026-10-20
category: integration-issues
module: desktop-sidecar
problem_type: integration_issue
component: authentication
severity: high
symptoms:
  - "Desktop 2.11.1 local-api.log: `cloud returned 401` for every proxied route, body `{\"error\":\"API key required\"}`"
  - "2.5.23 and 2.11.0 logged `cloud returned 403` for the same routes; the status changed with the release, the empty panels did not"
  - "desktop.log: `injected 0 keychain secrets into sidecar env` (no WORLDMONITOR_API_KEY, user not signed in)"
  - "Seed-only panels (climate, USNI fleet, conflict, markets, forecasts) stayed empty on a signed-out or free desktop"
root_cause: missing_permission
resolution_type: code_fix
related_components: [testing_framework]
tags: [desktop, sidecar, wm-session, anonymous-session, cloud-fallback, 401, fake-remote-tests]
---

# Signed-out desktop got a 401 on every cloud call once the User-Agent 403 was fixed

## Problem

On a signed-out or free desktop, the sidecar sent its cloud requests (`proxyToCloud` in `src-tauri/sidecar/local-api-server.mjs`) without any credential. The gateway has rejected keyless calls since #3541, so every seed-only panel came back empty (issue #7548).

## Symptoms

- 2.5.23 / 2.11.0: every cloud call got a **403**. That was the edge's short-UA block: requests arrived with the `node` User-Agent.
- 2.11.1 (after #9424 added `WorldMonitor-Desktop/<version> (sidecar)`): every cloud call got a **401** `API key required`.
- The user saw the same thing in both releases: no data.

## What Didn't Work

- **Treating the 403 → 401 change as a regression.** It was progress. #9424 fixed the User-Agent, so requests got past the edge and failed one step later, at credential validation. Each fix uncovered the next gate.
- **Asking the user for their own provider key (e.g. Open-Meteo).** Most of these routes are seed-only on the desktop. For example, `list-climate-anomalies` just reads a Redis seed that a Railway seeder builds. A local provider key has nothing on the desktop to use it, and it would fix one panel out of dozens.

## Solution

`proxyToCloud` now attaches the cached anonymous `wms_` session (the one `getCloudSessionToken` mints from `POST /api/wm-session`) to **every** cloud request that has no key. Before, it did so only when a Pro bearer was forwarded:

```js
// before: signed-out desktops stayed keyless
if (userBearer) {
  headers.set('Authorization', userBearer);
  if (!headers.has('X-WorldMonitor-Key')) { /* mint + attach session */ }
}

// after (#9440)
if (userBearer) headers.set('Authorization', userBearer);
if (!headers.has('X-WorldMonitor-Key')) { /* mint + attach session, same shared deadline */ }
```

Order of precedence is unchanged: a configured `WORLDMONITOR_API_KEY` or a key sent by the renderer still wins. A failed mint waits `CLOUD_SESSION_RETRY_MS` before retrying. Meanwhile the request still carries the cached session if one exists and hasn't expired. It goes out keyless only when there is no usable cached session.

## Why This Works

A signed-out desktop request, which carries only the anonymous session, now has the same access as an anonymous web visitor, and no more. A signed-in Pro desktop sends its Clerk bearer alongside the session, and the gateway authorizes those requests by the bearer, as it does for a Pro browser. `validateCredential` in `api/_api-key.js` rejects a session token whenever `forceKey` is set, so tier-gated routes stay closed to it.

Production check, sidecar run keyless against `https://api.worldmonitor.app`: `list-ucdp-events`, `list-climate-anomalies`, `get-usni-fleet-report` and `list-temporal-anomalies` all went from 401 on main to 200 with the fix.

## Prevention

- **To diagnose a desktop cloud failure, reproduce the sidecar's request directly with curl** rather than reading logs:
  ```bash
  curl -H 'Origin: https://worldmonitor.app' -H 'User-Agent: WorldMonitor-Desktop/2.11.1 (sidecar)' \
    https://api.worldmonitor.app/api/conflict/v1/list-ucdp-events        # 401 keyless
  # then repeat with -H "X-WorldMonitor-Key: <token from POST /api/wm-session>"  → 200
  ```
  Swapping the UA for `node` reproduces the old 403. Varying one header at a time shows which gate is failing.
- **Adding an upstream call to a proxy can make its fake-remote tests pass without testing anything.** After this change, a fake cloud that never responds swallowed the mint POST. The data request never went out, yet `cloudCalls === 1` still passed, because the counted call was the mint. Every fake cloud in `local-api-server.test.mjs` now calls `answerSessionMint(req, res)` first. When you add a pre-request call (auth, discovery, warm-up), find every fake remote that counts or records requests and make it answer the new call explicitly.
- `local-api-server.test.mjs` pins the signed-out contract: one cached session shared across requests, no `Authorization` header, and a keyless request when the mint fails.

## Related Issues

- Issue #7548 (reporter's logs across 2.5.23, 2.11.0, 2.11.1)
- #9424: sidecar User-Agent fix and Pro bearer forwarding (introduced the bearer-only mint)
- #3541: removal of Origin-trust; keyless calls became 401
- [one-route-401-declared-the-whole-anon-session-dead.md](../logic-errors/one-route-401-declared-the-whole-anon-session-dead.md): the web client's anonymous-session failure mode
