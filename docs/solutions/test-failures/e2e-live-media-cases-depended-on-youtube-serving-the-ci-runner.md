---
title: e2e live-media cases depended on YouTube serving the CI runner
date: 2026-11-18
category: test-failures
module: e2e/live-media-intent.spec.ts
problem_type: test_failure
component: testing_framework
severity: medium
root_cause: test_isolation
resolution_type: test_fix
symptoms:
  - "variant-smoke shard 3 fails 'always-on single webcam feed switch replaces the active stream' with Expected: 1, Received: 0 after a 30s poll"
  - "The failure screenshot shows 'Jerusalem is offline right now' in the Live Webcams panel"
  - "Passes on rerun and locally; failed on three of six heads of one PR that did not touch live media"
tags:
  - playwright
  - e2e
  - flaky-tests
  - youtube
  - live-video
  - ci-artifacts
  - trace-analysis
---

# e2e live-media cases depended on YouTube serving the CI runner

## Problem

The case "always-on single webcam feed switch replaces the active stream" in `e2e/live-media-intent.spec.ts` failed intermittently in CI. Thirteen of the spec's fifteen cases loaded real YouTube streams from the CI runner. Whether they passed depended on YouTube agreeing to serve a datacenter IP and on how fast the page loaded.

## Symptoms

- `expect.poll(() => webcamTransportCount(page), { timeout: 30_000 }).toBe(1)` fails with `Received: 0`.
- The screenshot shows the panel's offline card: "Jerusalem is offline right now", with Retry and "Open on YouTube".
- The case passes when the shard is rerun, and passes locally, including 5 of 5 with `--repeat-each=5` and a full local run of shard 3. It failed on three of six heads of PR #10992, which changed map and brief code only.

## What Didn't Work

- **Calling it flaky and rerunning.** Each rerun passed, but other branches ran the same shard green on the first attempt. Rerunning did nothing to explain why this case kept failing.
- **Blocking YouTube to reproduce it.** Aborting every YouTube request still passed. With no player response, the session waits for its verdict deadline, and the test's first poll sees the iframe long before then.
- **Firing the IFrame API's error alone.** An IFrame API stand-in that calls `onError(150)` at once also passed locally. The fast local load let the first poll count the iframe before the next observation failed the candidate.

## Solution

**Diagnosis:** read the trace inside the shard's Playwright artifact instead of guessing.

```bash
gh api "repos/<owner>/<repo>/actions/runs/<run-id>/artifacts?per_page=100" \
  -q '.artifacts[] | select(.name|test("smoke-3")) | .name'
gh run download <run-id> -n <artifact-name> -D art
unzip -q art/<failed-test-dir>/trace.zip -d trace
grep -o '"url":"[^"]*youtube[^"]*"' trace/*-trace.network | sort | uniq -c
```

The trace showed the real embed for the Jerusalem feed (`youtube.com/embed/zp6LNSoq000`) and a `youtubei/v1/player` response of 2,588 bytes. That is far smaller than a playable live player response, which points to a refusal; the body is cross-origin and was not recorded.

**Reproduction on `main`:** stand in for the refusal and the slow load together. The IFrame API stand-in fires `onError(150)`, and the test holds 5 seconds before its first poll. It fails with the exact CI screen.

**Fix (PR #10996):** the spec already had `stubLiveVideoProvider` (a blank embed plus an IFrame API stand-in that reports a live, playing stream), but only two cases used it. It now runs for every case:

```ts
test.describe('live media intent gating', () => {
  test.beforeEach(async ({ page }) => {
    await stubLiveVideoProvider(page);
  });
  // ...
```

With the same 5-second hold, the fixed case passes and makes no request to `youtubei/v1/player` or `googlevideo.com`. The spec passes 42/42 with `--repeat-each=3`.

## Why This Works

The panel's offline path is immediate for a feed with one candidate:

- `src/services/live-video/session.ts`: the IFrame API's `onError` handler records the code (`errorCode = data`).
- `src/services/live-video/model.ts`: the next observation returns `failed({ kind: 'player-error', code: errorCode })` whenever `errorCode !== null`, and `nextOrOffline` goes offline when no untried candidate remains.
- `src/config/live-video-sources.ts`: `jerusalem` has a single URL, so one failure takes the tile offline. `LiveWebcamsPanel` then shows the offline card in place of the iframe.

On a fast local load the test's first poll counts the iframe before that observation runs. On a slow CI load the verdict has already landed, so the iframe never appears. The cases test when media may start and stop, not whether a channel is live. A stub that always reports a live stream removes the network from the result.

## Prevention

- An e2e case that asserts on live-media transports must stub the provider. In this spec the stub runs in `beforeEach`, so new cases inherit it.
- When a CI failure screenshot shows product state that depends on an outside service (an "offline" card, a fallback, an empty list), check that service's requests in `trace.zip` before treating the failure as a timing flake.
- To reproduce a race between a product verdict and a test poll, reproduce both sides: the outside service's answer, and the slower load. Either one alone may pass locally.
- Related: [A lost browser is already legible in the Playwright artifact you upload](../conventions/a-lost-browser-is-already-legible-in-the-playwright-artifact.md) covers reading the same artifact for browser-loss failures; [live video panels silently degrade](../integration-issues/live-video-panels-silently-degrade-dead-youtube-detection-rotted-fallback-ids-idle-stop.md) covers the product side of YouTube liveness detection.
