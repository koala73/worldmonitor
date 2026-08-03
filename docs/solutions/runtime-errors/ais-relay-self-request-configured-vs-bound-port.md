---
title: "Relay self-request used the configured PORT, not the bound port — silent OpenSky skip under ephemeral binds"
date: 2026-08-03
category: runtime-errors
module: scripts/ais-relay.cjs
problem_type: runtime_error
component: background_job
symptoms:
  - "[TheaterPosture] OpenSky failed: fetch failed logged during the theater-posture seed cycle"
  - "/metrics reports opensky.requests=0 even though the OpenSky tier should have run"
  - "Theater posture cycle silently falls through to adsb.lol/Wingbits fallbacks with no error surfaced"
  - "Reproduces only when the relay is spawned with PORT=0 (ephemeral bind); masked in production where PORT is a real fixed value"
root_cause: config_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [ais-relay, self-request, port-binding, ephemeral-port, theater-posture, opensky, railway]
---

# Relay self-request used the configured PORT, not the bound port — silent OpenSky skip under ephemeral binds

## Problem

`scripts/ais-relay.cjs` is a ~12k-line Node relay deployed as a Railway service. Its theater-posture seed loop (`fetchTheaterFlightsFromOpenSky`, `scripts/ais-relay.cjs:4228-4258`) does not call the OpenSky Network API directly — it calls back into its **own** HTTP server's `/opensky` route (`scripts/ais-relay.cjs:4233`) purely to reuse that route's existing caching/cooldown/auth machinery. That in-process self-request was built from a module-level `PORT` constant:

```js
// scripts/ais-relay.cjs:69 (unchanged, still the configured port)
const PORT = process.env.PORT || 3004;

// scripts/ais-relay.cjs:4233 (before the fix)
const resp = await fetch(`http://localhost:${PORT}/opensky?${params}`, {
```

`PORT` holds whatever `process.env.PORT` was *configured* to, not whatever the server actually *bound*. Those two values are identical in production (Railway sets a real, fixed port), which is exactly why this survived undetected: nothing in production ever exercised the mismatch.

## Symptoms

- Under `PORT=0` — the ephemeral-bind convention used by the test harness's standard spawn config so tests don't collide on a fixed port — every self-request to `http://localhost:0/opensky?...` failed instantly with a generic `fetch failed`, since port `0` is not a real listening address to connect *to* (it only means "pick one" when *binding*).
- The seed cycle logged `[TheaterPosture] OpenSky failed: fetch failed` (the catch-site log at `scripts/ais-relay.cjs:4437`).
- `/metrics` reported `opensky.requests: 0` — the request never reached the server at all, so none of the route's own instrumentation (cooldown, throttle, success counters) ever fired.
- The cycle silently fell through to its degraded fallbacks (adsb.lol, then Wingbits) with no error surfaced to an operator — the outcome looked identical whether OpenSky was actually down or the self-request was structurally broken.
- Production was completely unaffected and showed no symptom, because production's configured `PORT` and bound port are the same value. The bug was invisible until an end-to-end test tried to drive the OpenSky path specifically.

## What Didn't Work

An end-to-end test (`scripts/ais-relay-ingestion.test.cjs`) spawned the relay with `PORT: '0'` (`scripts/ais-relay-ingestion.test.cjs:44`) and asserted, after triggering a seed cycle, that `metrics.opensky.throttle >= 1` — expecting the self-request to at least reach the route's cooldown/throttle logic. The assertion failed with `metrics.opensky.requests` at `0`. A debug run surfaced the `[TheaterPosture] OpenSky failed: fetch failed` line, which traced back to the literal request URL `http://localhost:0/opensky?...` — port `0` doesn't answer, so the fetch fails before any HTTP semantics (auth, 429, cooldown) ever apply. No amount of adjusting the OpenSky stub sequence, cooldown state, or auth headers fixed it, because the request was never reaching the process's listener in the first place — the actual bound port and the value in the URL were different numbers.

## Solution

Resolve the bound port exactly once, at listen time, into a module-level variable, and build every self-request from that variable instead of from the configured `PORT`.

Before (`scripts/ais-relay.cjs`, pre-#6092):
```js
const PORT = process.env.PORT || 3004;
...
const resp = await fetch(`http://localhost:${PORT}/opensky?${params}`, { ... });
...
server.listen(PORT, () => {
  const listeningPort = server.address()?.port || PORT;
  console.log(`[Relay] WebSocket relay on port ${listeningPort} ...`);
  ...
});
```

After (current tree, PR #6092 — open, unmerged as of this writing):
```js
// scripts/ais-relay.cjs:69-73
const PORT = process.env.PORT || 3004;
// Actual bound port, resolved at listen time. Self-requests must use this:
// with PORT=0 (ephemeral bind, used by tests) the env value is not the port
// the server listens on, and `http://localhost:0` fails outright.
let relayBoundPort = PORT;

// scripts/ais-relay.cjs:4233
const resp = await fetch(`http://localhost:${relayBoundPort}/opensky?${params}`, { ... });

// scripts/ais-relay.cjs:12022-12024
server.listen(PORT, () => {
  const listeningPort = server.address()?.port || PORT;
  relayBoundPort = listeningPort;
  ...
});
```

`relayBoundPort` is declared next to `PORT` with an explanatory comment, initialized to `PORT` as a safe default before the server has bound anything, then overwritten inside the `server.listen` callback with whatever `server.address()?.port` actually resolved to. The self-request at `scripts/ais-relay.cjs:4233` was repointed from `PORT` to `relayBoundPort`.

## Why This Works

`server.listen(0, cb)` asks the OS to pick a free ephemeral port; Node only exposes that real port afterward, via `server.address().port`, inside (or after) the listen callback. Any code that needs to *address* the server it just started — as opposed to *configuring* how it starts — must read that resolved value, not the input configuration. `relayBoundPort` closes that gap: it starts equal to the configured `PORT` (so a fixed, non-zero `PORT`, as in production, needs no correction — behavior there is provably unchanged), and gets corrected once the true bound port is known. Every self-request now targets a port the server is actually listening on, in every environment, not just the ones where `PORT` happens to be a real fixed value.

## Prevention

- **Reusable rule: any in-process self-request (a service calling back into its own HTTP server to reuse a route's logic) must be built from the listener-resolved bound port (`server.address()?.port`), never from the configured `PORT` env/default.** The two are only guaranteed equal when the configured port is a real, fixed value — they diverge silently under `PORT=0` (ephemeral bind) or any environment that lets the OS choose the port. Treat "configured port" and "bound port" as distinct values with distinct lifetimes: the configured value exists before `listen()`; the bound value only exists after the listen callback fires. Code that *addresses* the server (self-requests, self-referential URLs) must use the latter.
- **Regression pin:** a test harness that spawns a service with `PORT=0` must not just check the process boots — it must drive a code path that issues a self-request and assert the self-request actually **lands** (a route-level counter increments, or a success/throttle metric moves off zero). `scripts/ais-relay-ingestion.test.cjs` does this: under `PORT: '0'`, one test drives a seed cycle and asserts `metrics.opensky.success >= 1` after an OpenSky-success stub sequence, including a variant with `RELAY_SHARED_SECRET` set so the self-request is proven to carry the `x-relay-key` auth header end-to-end. A test that only checks "the process didn't crash" or "the fallback path worked" would have stayed green through this entire bug — the assertion has to target the specific self-request's own success signal.
- That test file is now wired into `npm run test:sidecar` (`package.json:113`); it previously existed but was referenced by no script or workflow and so never gated CI (per PR #6092's description).

## Related Issues

- Origin: issue #5945 (aviation/RSS throttling observability); fix shipped in PR #6092 (`fix/theater-posture-source-attribution-5945`), open and unmerged as of this writing.
- See also: `docs/solutions/logic-errors/curl-failure-sentinel-doubled-by-echo-fallback.md` — shared meta-lesson: a local-target self-check that looks correct on the healthy path and only reveals its defect when probed against a genuinely dead/closed target.
- See also: `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md` — the standing convention for proving the regression pin actually catches the regression (revert `relayBoundPort` to `PORT`, confirm the test goes red).
