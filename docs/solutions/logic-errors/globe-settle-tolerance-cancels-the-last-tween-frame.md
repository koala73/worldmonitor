---
title: "Globe settle-by-tolerance cancelled the tween's last frame and left the camera short of the target"
date: 2026-11-23
category: logic-errors
module: globe-viewport
problem_type: logic_error
component: frontend_stimulus
severity: low
symptoms:
  - "e2e/plugin-news-metering.spec.ts expected globe receipt longitude 139 and received 138.9999305 on a CI push run"
  - "The latitude assertion on the line before passed; only the longitude missed, by about 7e-5 degrees"
  - "The failure is rare and depends on runner speed"
root_cause: async_timing
resolution_type: code_fix
related_components: [testing_framework]
tags: [globe, globe-gl, viewport-settle, tween, request-animation-frame, fake-timers, flaky-e2e, camera-receipt]
---

# Globe settle-by-tolerance cancelled the tween's last frame and left the camera short of the target

## Problem

A tracked globe move (`GlobeMap.moveViewport`) runs a 1200 ms tween driven by `requestAnimationFrame` and also schedules a settle check at `durationMs + 50`. The settle check treats a camera within 1e-4 degrees of the target as arrived (`trySettleViewportMovement` in `src/components/GlobeMap.ts`). When that timer ran before the tween's final frame, settlement bumped the movement generation and cancelled the pending frame. The camera stayed where the last eased frame left it, and every receipt read that position (WM #11184).

## Symptoms

- `expect(globe.center?.lon).toBeCloseTo(139, 4)`: received `138.9999305`, difference `6.95e-5`.
- Seen once in 29 failed Test attempts across five days, on `variant-smoke-pro-webmcp (plugin-news)`.

## What Didn't Work

The issue listed two candidate causes, and the code rules out both:

- **OrbitControls auto-rotation resuming after settlement.** For a renderer-only `apply_news_view`, nothing awaits between `await map.whenViewportSettled()` and the receipt's `map.getCenter()` (`src/plugin-main.ts`, `applyView`). The settle promise resolves in microtasks, so no animation frame can rotate the camera in between.
- **Float loss in the camera round trip.** The `progress === 1` branch writes the exact target, and a float64 round trip errs around 1e-14, not 1e-5.

Throttling the CPU and rerunning the e2e would not have reproduced it reliably. The failing window is a final frame landing about 1193–1195 ms into the tween and then no frame until 1250 ms.

## Solution

Write the target before settling in the `atTarget` branch:

```ts
if (atTarget) {
  // The settle timer can find the camera inside the tolerance while the
  // tween's last frame is still pending. Settling cancels that frame, so
  // write the target here or the camera stays short of it.
  this.globe!.pointOfView(target!, 0);
  this.settleViewportMovement(true, generation);
  return;
}
```

The tween already makes the same `pointOfView(target, 0)` call on every frame, so this adds no new kind of camera write. The e2e precision (4 decimals) was left unchanged. The fix is in PR #11192, which was unmerged at the time of writing.

## Why This Works

The numbers pin the timer path. The tween starts at the `global` preset (20, 0) and eases to (35, 139) with `1 - (2 - 2p)^3 / 2`. A last frame at p = 0.995 leaves `139 · 0.01^3 / 2 = 6.95e-5` degrees of longitude and `15 · 0.01^3 / 2 = 7.5e-6` of latitude. Both are inside the 1e-4 settle tolerance, so the timer accepts the camera. The latitude residual passes a 4-decimal check and the longitude residual fails it, which matches the CI result. Snapping on acceptance makes "settled" mean "at the target" on every path, not only on the path where the final frame wins the race.

## Prevention

- When a settle or done check accepts "close enough" and also cancels the animation that would have finished the job, finish the job in the same branch. A tolerance check that only observes a position, without correcting it, makes the result depend on frame timing.
- Reproduce a frame-timing race with a hand-driven `requestAnimationFrame` stub under vitest fake timers, not with CPU throttling. `tests/dom/globe-viewport-runtime.test.mts` queues the callbacks and runs them at chosen times, so the test can stop the tween at 99.5% and let the settle timer decide:

  ```ts
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
  const frameAt = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms - performance.now());
    for (const callback of frames.splice(0)) callback(performance.now());
  };
  ```

  Before the fix, this test failed with `{ lat: 34.9999825, lon: 138.9999305 }`, the same longitude as the CI run. Matching the CI value exactly is strong evidence that the path is the right one.
- Before loosening an e2e precision, compute the residual each candidate cause would produce and compare it with the observed miss.
