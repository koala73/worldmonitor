---
title: A perf bench gain needs matched env, a control, and a per-term breakdown before you report it
date: 2026-11-24
category: best-practices
module: perf hill-climb bench
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Comparing two builds with a composite benchmark score, such as the app-perf hill-climb"
  - "The baseline and the candidate are built in different worktrees"
  - "A benchmark metric is the time a network response arrives, not the time its content renders"
  - "The benchmark's headless browser may pick a different renderer than real users get"
  - "A benchmark fixture feeds the code under test a single fixed input"
tags:
  - performance
  - benchmarking
  - vite-env
  - worktrees
  - hill-climb
  - svg-renderer
  - measurement
---

# A perf bench gain needs matched env, a control, and a per-term breakdown before you report it

## Context

The app-perf hill-climb scores a build with one composite number (lower is better) from a headless Chromium run under 4x CPU throttle, plus a mobile holdout. The bench script is a local file on the hill-climb branch, not committed to `main`.

On 2026-11-24 the first A/B reported 109.5 for `main` and 82.2 for the candidate, a 25% drop, and the mobile holdout seemed to agree (642 to 445). After controlling the setup, the same candidate measured 81.7 against a 104.2 baseline over five alternating rounds. Roughly 8 of those 22 points were edge CPU under 2 ms per request, roughly 4 were the time a news request starts, and roughly 9 were main-thread lag and bytes on the SVG map renderer. The headline had overstated the user-visible gain by about 2x, and the holdout was not an independent check. The work was opened as #11235 (KV serve) and #11237 (SVG map).

## Guidance

Run these checks before reporting a bench gain.

1. **Build every compared tree with the same effective env.** `npm run worktree:bootstrap` links `.env.local` into the worktree, and Vite bakes the `VITE_*` values it holds (for example `VITE_SENTRY_DSN`) into the bundle. A worktree without the link builds a different bundle. The baseline with the link measured 656.7 KB of brotli code against 647.2 KB without it, and scored about 5 points worse. Matching that one link is not enough in general. Vite also reads `.env`, `.env.[mode]`, and `.env.[mode].local`, and process variables override them. Compare the effective values for the build mode. The simplest way to match is no env file in any tree and the same `VITE_*` process variables in every build shell.
2. **Keep a control, and check that it cannot reach the changed code.** A control is a change that should not move the metric. Here it was the KV serve PR, and it controls the browser metrics only. It changes the edge hot-path term, which moved the composite by about 7.9 points, so use an A/A control (the same build measured twice) for the composite. The bench serves fixed synthetic bodies from its own server, so the KV code never ran during the browser pass and its bundle should have matched the baseline's. In the first run it did not. The control showed 9.5 KB less brotli code and about 80 ms less lag, and that exposed the env mismatch in item 1. With the env matched, the control's browser metrics stayed within about 1 point and 5 ms of lag of the baseline at the medians, while single baseline runs ranged from 102.1 to 115.4 under machine load. A server-side change is a valid browser control only when both builds use the same backend and fixtures. Alternate the builds across at least five rounds, report medians and ranges, and treat a gap inside the control's spread as inconclusive. Collect more rounds before you call it a gain or no difference.
3. **Know which renderer the bench exercises.** Headless Chromium reports a SwiftShader GPU, so `hasWebGLSupport()` returns false (`src/components/MapContainer.ts:390`) and `shouldUseDeckGL()` returns false (`src/components/MapContainer.ts:418`). The bench therefore runs the SVG renderer in `src/components/Map.ts`. A desktop browser with WebGL2 runs deck.gl instead, and mobile already loads the 110m topology (`src/config/geo-map.ts:2524`, `src/config/geo-map.ts:2528`). A gain found on the SVG path does not transfer to typical desktop users.
4. **Check what a time metric measures, then decompose the composite by term.** The bench's `newsReady` is the arrival of the `/api/news/v1/list-feed-digest` response, and the World News panel stays a deferred skeleton for the whole run. Starting that request earlier lowers the metric without changing when news appears. The mobile holdout uses the same event, so it shares the flaw. Convert each term's delta to points with the composite's weights and ask of each whether a user would notice it.
5. **Build fixtures from the production builder, and measure cold and warm separately.** The bench's KV envelope listed `tier` before `generatedAt`, while the publisher writes `schemaVersion, generatedAt, tier, payload` (`shared/bootstrap-tier-envelope.js:18`). It also returned one fixed string, so a per-isolate payload cache hit on every call. The honest numbers, with the real key order under Node 24, were 3.34 ms to 0.25 ms for a repeat hit on a 700 KB tier and 4.38 ms to 3.51 ms for a hit on a new value.

## Why This Matters

A composite score hides which terms moved. Without the env match, the control, and the breakdown, a worktree setup difference and a timing artifact read as product speedups, and the report claims a gain users will not see.

## When to Apply

- You compare a baseline and a candidate built in separate worktrees.
- A benchmark's headless browser may select a different code path from the one most users run.
- A metric is derived from a network event rather than a paint or an interaction.
- A fixture returns the same input on every call to code that caches.

## Examples

Per-step medians over five alternating rounds against the same baseline (104.2):

| Change | Score change | What actually moved |
|---|---|---|
| KV serve and `jsonResponse` | -9.3 | edge CPU 1.58 to 0.40 ms (about 7.9 points). Browser metrics unchanged, as the control predicts. |
| SVG map level of detail | -8.5 | lag -93 ms, total blocking time -113 ms, runtime transfer -252 KB. SVG renderer only. |
| Boot waterfall | -4.4 | all of it is the news request timing. Shell +50 ms and LCP +12 ms were slightly worse. |
| WebMCP split | -0.5 | code -10.7 KB brotli, nothing else |

## Related

- #11235 `perf(edge): parse the KV bootstrap envelope once and reuse its payload`
- #11237 `perf(map): paint the SVG map from the 110m topology and load 50m on zoom`
