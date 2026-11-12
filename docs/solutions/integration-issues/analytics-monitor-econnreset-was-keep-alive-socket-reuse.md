---
title: The analytics collector monitor paged on ECONNRESET from reused keep-alive sockets, not from the collector
date: 2026-11-05
category: integration-issues
module: analytics
problem_type: integration_issue
component: tooling
symptoms:
  - "Analytics Collector Monitor fails with `1/12 attempts failed ... ECONNRESET (phase=request)`"
  - "The failed write is always in burst 2 or 3, never burst 1"
  - "The failure arrives 13-113 ms after the request starts, with no HTTP status"
  - "The next scheduled run is green and Railway shows no matching collector error"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components: [testing_framework]
tags: [umami, analytics, monitor, undici, keep-alive, econnreset, cloudflare, node-fetch, false-alarm]
---

# The analytics collector monitor paged on ECONNRESET from reused keep-alive sockets, not from the collector

## Problem

The scheduled Analytics Collector Monitor (`.github/workflows/analytics-collector-monitor.yml`) failed about once every one to two days with a single failed write canary. The collector was healthy. Node's fetch had sent the write on an idle keep-alive socket that the Cloudflare edge reset, and Node fetch does not resend a request lost that way. Fixed in #10079.

## Symptoms

- Monitor output: `1/12 attempts failed` with `ECONNRESET (phase=request)`.
- 10 such failures between 2026-10-21 and 2026-11-03, in 1,842 monitor runs.
- Every one was in write burst 2 or 3. Burst 1 never failed this way.
- Elapsed time at failure: 13-113 ms, before any response headers arrived. The timing points to the socket-reuse pattern, but it does not show whether the collector received or committed the write.

## What Didn't Work

- **Reading it as a collector outage.** Adjacent runs were green and the failure never hit burst 1, which is the burst that meets a cold collector.
- **Adding `Connection: close` to the write canaries only.** The regression test still failed with `UND_ERR_SOCKET`. The liveness GETs run before the bursts and leave idle sockets in the same pool, and burst 2 writes picked those up.

## Solution

`buildProbeRequest` in `scripts/check-analytics-collector.mjs` now sends `Connection: close` on every probe, both GETs and writes, so no idle socket is ever left in undici's pool:

```js
const headers = { 'User-Agent': probe.userAgent || USER_AGENT, Connection: 'close' };
```

The regression test in `tests/analytics-collector-monitor.test.mjs` ("opens a fresh connection for every write canary...") starts a local server that destroys any POST arriving on an already-used socket. It asserts that no write fails and that the 12 writes used 12 distinct sockets. The test failed before the change and passes after it.

The workflow runs the script without `npm ci`, so the script cannot import `undici` to configure an `Agent`. A per-request header is the fix that works with only the bundled global `fetch`.

## Why This Works

The monitor sends 3 concurrent bursts of 4 writes, 3 s apart. Burst 1 opens fresh connections. Bursts 2 and 3 reuse sockets that sat idle for about 3 s, and the edge occasionally resets one just as the request is written. A browser retries a request lost on a reused socket. Node fetch surfaces it as `ECONNRESET`, and any failed write fails the run (the #5715 acceptance gate). With `Connection: close`, each probe gets a fresh socket, so there is no idle socket to reset.

The cause was proven by counting socket reuse with `node:diagnostics_channel`, without changing the script:

```js
import dc from 'node:diagnostics_channel';
const seen = new Set();
let requests = 0, reused = 0;
dc.subscribe('undici:client:sendHeaders', ({ socket }) => {
  requests++;
  if (seen.has(socket)) reused++;
  seen.add(socket);
});
process.on('exit', () => console.error(`requests=${requests} reusedSockets=${reused}`));
```

Run with `node --import ./count-sockets.mjs scripts/check-analytics-collector.mjs`. Before the fix, bursts 2 and 3 reused sockets. After the fix, a live production run reported `requests=15 reusedSockets=0` and 0/12 failed writes.

Production check after the merge (2026-11-03 05:10 UTC): 343 of 343 monitor runs passed over about 45 hours. At the old rate of 10 failures in 1,842 runs, the chance of 343 clean runs without the fix is about 16%. The clean streak supports the fix but does not prove it alone; the regression test and the socket counts are the stronger evidence.

## Prevention

- When a monitor fires several requests at one host with idle gaps between them, assume Node fetch will reuse sockets and will not retry a reset. Either close connections or treat a request-phase reset on a reused socket as transport noise.
- When the monitor goes red, check the burst number and `elapsedMs` first. An `ECONNRESET` in burst 2 or 3 within about 100 ms is this transport pattern. After #10079 it should not recur, so a new one points at something else.
- All four burst-1 writes failing with HTTP 500 at about 10.2 s (seen 2026-10-30 and twice on 2026-10-31) is a different failure in the collector or its database. This fix does not cover it.

## Related Issues

- #10079: the fix.
- #5715: the collector acceptance gate that makes any failed write fail the run.
- [`docs/analytics-collector-operations.md`](../../analytics-collector-operations.md): the "Diagnose a monitor transport failure" runbook section.
- [Umami answers HTTP 200 when it drops a bot write](umami-answers-http-200-when-it-drops-a-bot-write.md): an earlier false alarm in the same alerting path, with a different cause.
