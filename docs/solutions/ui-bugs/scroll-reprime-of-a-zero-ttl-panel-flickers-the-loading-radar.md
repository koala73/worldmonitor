---
title: "Scroll re-prime of a zero-TTL panel flickers the loading radar on every scroll tick"
date: 2026-08-07
category: ui-bugs
module: "src/app/data-loader.ts, src/components/ChinaCorridorPanel.ts, src/components/ChinaActivityNowcastPanel.ts, src/App.ts"
problem_type: ui_bug
component: frontend
symptoms:
  - "Scrolling up or down on the dashboard makes exactly the China Logistics Corridors and China Activity Nowcast panels flicker and show the loading radar until scrolling stops; other panels stay stable"
  - "The flicker recurs on every scroll re-entry, not once per session, because App.ts's rAF-throttled window scroll listener (handleViewportPrime) re-runs dataLoader.loadAllData() on each scroll event"
  - "Each re-entry is a full production RPC round-trip, not a cache hit, because both services deliberately run with zero-TTL circuit-breaker cache policies (the server owns aggregate caching; a client last-good cache would hide fail-closed responses)"
  - "Sibling panels driven through the same viewport-gated loadAllData() path (e.g. MarketBreadthPanel) do not flicker, because their fetchData() only calls showLoading() when nothing is rendered yet"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [scroll-handler, viewport-prime, showloading, cachettlms-zero, circuit-breaker-cache, skipifpopulated, data-loader, loading-radar-flicker]
---

# Scroll re-prime of a zero-TTL panel flickers the loading radar on every scroll tick

## Problem

On the worldmonitor.app dashboard, scrolling made exactly two panels — **China Logistics Corridors** and **China Activity Nowcast** — flicker back to the loading radar. Every scroll event replaced their rendered content with the spinner for the duration of a full RPC round-trip, and the flicker only stopped when the user stopped scrolling. No other panel behaved this way.

The bug sits at the intersection of three independently reasonable design decisions:

**1. Scroll re-triggers the whole data fan-out.** `handleViewportPrime` (`src/App.ts:280-302`) is registered as a `passive`, `capture`-phase window scroll listener (`src/App.ts:2052-2055`; a plain resize listener at `:2056` routes through the same handler) and rAF-throttled via `visiblePanelPrimeRaf` (`src/App.ts:289-291`). Inside the rAF it calls both `primeVisiblePanelData()` and `dataLoader.loadAllData()` (`src/App.ts:293-300`). This is deliberate: bootstrap runs with `forceAll=false`, so below-fold panels depend on the scroll re-trigger to ever load at all. The comment states the contract that made it safe — *"Both are viewport-gated and inflight-guarded — repeat invocations are cheap"* (`src/App.ts:297-299`).

**2. The inflight guard only stops *concurrent* duplicates.** `runGuarded` (`src/app/data-loader.ts:900-910`) adds the task name to `ctx.inFlight` before awaiting and deletes it in `finally`. Once a load settles, the very next scroll event is free to re-run it. It is a concurrency guard, not an idempotence guard — so "repeat invocations are cheap" was an unenforced assumption about each registered loader, not a property of the mechanism.

**3. These two panels' loaders drop straight into an uncached RPC behind an unconditional spinner.** The `loadAllData` registrations at `src/app/data-loader.ts:964` and `:967` route to `loadChinaCorridors()` / `loadChinaActivityNowcast()` (`src/app/data-loader.ts:3938`, `:3954`), which delegate to `panel.fetchData()`. Both panels' `fetchData` previously opened with an unconditional `this.showLoading()`. And both services deliberately run with **no client cache**: `CHINA_CORRIDOR_BREAKER_CACHE_POLICY` sets `cacheTtlMs: 0, maxCacheEntries: 0` because *"the server already owns healthy aggregate caching. Client-side last-good caching would hide successful fail-closed responses behind stale data"* (`src/services/supply-chain/china-corridor-control-towers.ts:15-20`); `CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY` says the same (`src/services/economic/china-activity-nowcast.ts:16-21`).

The visual asymmetry that makes the flicker so stark comes from `Panel`'s two write paths having different latencies. `showLoading()` calls `replaceContent()`, a direct `replaceChildren` on the content node — **immediate** (`src/components/Panel.ts:878-891`, `:1225-1228`). Data renders go through `setSafeContent` → `setContentHtml`, which queues behind a **150 ms debounce** (`src/components/Panel.ts:1230-1273`, timer at `:1268-1272`, `contentDebounceMs = 150` at `:142`). So each scroll event wiped the panel instantly and the recovery was gated on both the network round-trip and the debounce.

Worse, all this work was pure waste: both panels already have a scheduled 15-minute refresh (`src/App.ts:2842-2843`, with `REFRESH_INTERVALS.chinaCorridors` and `.chinaActivityNowcast` both `15 * 60 * 1000` at `src/config/variants/base.ts:50-51`). The scroll path was not the only refresh mechanism — it was a redundant one that also happened to be destructive.

## Symptoms

- Scrolling the dashboard up or down made the China Logistics Corridors and China Activity Nowcast panels drop their rendered content and show the loading radar, repeatedly, until scrolling stopped. Sibling panels in the same grid were unaffected.
- The flicker scaled with scroll activity, not with data staleness: a panel whose data was seconds old flickered just as hard as one at the end of its refresh window.
- In production every flicker was a real RPC round-trip, so the two panels issued one uncached backend request per scroll frame that survived the rAF throttle.
- On an empty/degraded payload the corridor panel additionally swapped a fully rendered set of corridors for the error state, even though it had just been showing valid content.

## What Didn't Work

The code fix was straightforward once the chain was understood. The expensive part was building a browser harness that could actually *prove* the bug and the fix — and the first two attempts produced confident, meaningless green results.

**Scrolling the wrong element produced a vacuous pass.** The first harness located the scroller by walking up from a panel to the first ancestor with `scrollHeight > clientHeight`, which selected `.panels-grid`. That element is not actually scrollable in this layout: `scrollTop` writes do not stick and no scroll events fire from it. The harness scrolled "successfully" 26 times and observed zero flicker — on the *unfixed* code. The real scroller is `.main-content` (writes to `scrollTop` stick, and the resulting events reach the window capture listener). Note that `handleViewportPrime` itself filters scroll targets to `.main-content, .panels-grid` (`src/App.ts:282-288`), which is exactly the kind of detail that makes a plausible-but-wrong scroller choice look legitimate.

The fix was to stop trusting the scroll and instrument the code path directly. `markLcpDebug` is a no-op unless an opt-in recorder is installed (`src/utils/lcp-debug.ts`), so setting `window.__wmLcpDebug = { enabled: true, marks: [] }` before the storm and counting marks named `wm:hydration:viewport-trigger` — emitted inside the rAF at `src/App.ts:292` — turns "did the buggy path run?" into a number. Pre-fix and post-fix runs both showed `viewportPrimeFired=26`, which is what makes the post-fix zero-flicker result meaningful rather than an artifact of a storm that never fired. (The recorder caps at `MAX_MARKS = 120`, so a longer storm needs a different counter.)

**RPC counters are a dead discriminator in local dev.** The obvious metric — count network calls to the two endpoints — reads `0` in *both* the fixed and unfixed builds locally, because the RPC endpoints don't exist in dev, the circuit breaker opens, and `fetch` is never reached. A metric that reads identically on both sides of the fix discriminates nothing. The discriminator that works locally is the DOM itself: a 50 ms sampler polling for `.panel-loading` inside the two panels' content nodes. Pre-fix: 15 of 139 samples caught the radar. Post-fix: 0 of 137.

**Mutation-checking the harness** (confirming it can still fail) was done by restoring the pre-fix sources with `git show HEAD:<path> > <path>` against scratchpad backups — never `git checkout` or `git stash`, both of which would have reached beyond the files under test in a worktree that shares its stash stack with other sessions.

## Solution

Three coordinated changes, all currently uncommitted on `worktree-greedy-drifting-wombat` (no PR opened yet), plus a regression test.

**1. Panels keep their last render across a refetch.** Both panels gained a `hasData()` predicate and now gate their loading state on it:

- `src/components/ChinaCorridorPanel.ts:139` — `if (!this.hasData()) this.showLoading();`, with `hasData()` at `:154-156` returning `this.response.corridors.length > 0` (the field is initialized to `{ generatedAt: '', corridors: [] }` at `:103`, so it is `false` before the first successful load).
- `src/components/ChinaActivityNowcastPanel.ts:25` — same gate, with `hasData()` at `:31-33` returning `this.response !== null` (`:8`).

The corridor panel's empty-payload branch got the same treatment (`src/components/ChinaCorridorPanel.ts:144-149`): an empty response on an already-populated panel keeps the last truthful render instead of swapping in the error state, while a first load that comes back empty still fails closed to `showError`.

**2. The scroll path stops refetching populated panels at all.** Both loaders now take an option and return early:

- `src/app/data-loader.ts:3938-3945` — `loadChinaCorridors(options?: { skipIfPopulated?: boolean })` with `if (options?.skipIfPopulated && panel.hasData()) return;`
- `src/app/data-loader.ts:3954-3959` — the same for `loadChinaActivityNowcast`.

The two scroll-driven callers pass it: the `loadAllData` registrations (`src/app/data-loader.ts:964`, `:967`) and `primeVisiblePanelData` (`src/App.ts:750`, `:753`). The callers that *should* refetch do not pass it and are untouched — the 15-minute scheduler (`src/App.ts:2842-2843`) and the error-retry callback (`src/app/data-loader.ts:3950`).

**3. Regression tests.** `tests/dom/china-panel-refetch.test.mts` (8 tests) runs under vitest + happy-dom because `Panel` needs a DOM and `@/services/i18n`'s `import.meta.glob` graph, neither reachable from the `tsx --test` profile. It uses fake timers to advance past the 150 ms content debounce and deferred promises to hold a fetch open mid-flight so the in-flight DOM state can be asserted. Coverage: first-load radar appears; a refetch keeps rendered content; an empty refetch keeps rendered content; a first load that is empty still fails closed; and `hasData()` semantics for both panels.

Verification: the 8 tests failed 5/8 against the restored pre-fix sources (observed in this fix's own verification run) and pass 8/8 at the current tree. The full `test:dom` suite ran 227 passed, and `typecheck` and `biome` were green.

## Why This Works

**Layer 1 (the panel) makes the flicker structurally impossible; layer 2 (the loader) removes the wasted work.** Either change alone would have stopped the visible flicker, but only together do they also stop the redundant RPC storm. The loader-level `skipIfPopulated` short-circuit is the cheap win — it means a scroll event does zero network work for a populated panel — while the panel-level `hasData()` gate is the durable one: it protects the panel from *any* future caller that refetches, including callers that don't exist yet.

**Option-gating rather than unconditionally skipping preserves the refresh contract.** The distinction that matters is between callers that fire on *user input* (scroll, resize — arbitrarily frequent, carrying no information about staleness) and callers that fire on a *staleness clock* (the 15-minute scheduler) or on an *explicit user request* (the error-retry button). Only the first group passes `skipIfPopulated: true`. Data still refreshes on exactly the cadence it did before.

**`hasData()` gating does not hide fail-closed states.** This is the subtle risk of the change, and it is closed by the shape of the fallback: `createUnavailableChinaCorridorControlTowerResponse` (`shared/china-corridor-control-towers.ts:200-223`) always maps over `CHINA_LOGISTICS_CORRIDORS` and returns all four corridors with `availability: 'unavailable'` on every signal family. A fail-closed response therefore has `corridors.length > 0` and renders truthfully as "unavailable" rather than being suppressed. `hasData()` returning `false` genuinely means *nothing has ever rendered*, which is the only case where the loading radar and the error state are the correct thing to show. That is also why the original `cacheTtlMs: 0` reasoning is preserved: nothing here caches a response or serves a stale one — the panel merely declines to erase pixels it already drew while it fetches a fresh answer.

**Skip-gating a load is safe here by the checklist in [deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing](../design-patterns/deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md).** The "done" marker is the presence of rendered data itself — an empty or failed load never calls `setData`, so `hasData()` stays `false` and every retry path (scroll re-entry, the error-retry button, the scheduler) remains armed. The load takes no request parameters, so there is no mutated input the gate could fail to cover, and the panel is the load's only consumer, so no late-mounting consumer needs a backfill.

**The pattern matches an established sibling.** `MarketBreadthPanel.fetchData` (`src/components/MarketBreadthPanel.ts:192-203`) shows loading only after the hydrated-data path misses, and its RPC path shows an error only `if (!this.data)` (`:212`). The data-loader also already duck-types this exact predicate: `panelHasRetainedData` (`src/app/data-loader.ts:398-401`) checks for a `hasData?: () => boolean` method to decide whether a cold-load error may overwrite a panel. The China pair was the outlier, not the new shape.

**The other loaders were never exposed to this.** They either fetch and call `updateData()` with no loading state at all, or they sit behind circuit breakers with real TTLs — `src/services/supply-chain/index.ts:70-72` shows 60-minute, 90-minute, and 24-hour caches for shipping rates, chokepoints, and critical minerals — so their scroll re-entries are served from cache. Only the two panels that combined an unconditional `showLoading()` with a `cacheTtlMs: 0` policy (`src/services/supply-chain/index.ts:73-76` wires the zero policy into the corridor breaker) could produce a full-round-trip spinner per scroll event. That is exactly why the flicker hit two panels and no others.

## Prevention

**Treat the `handleViewportPrime` comment as a contract with teeth.** *"Both are viewport-gated and inflight-guarded — repeat invocations are cheap"* (`src/App.ts:297-299`) is a requirement imposed on every loader registered in `loadAllData`, not a description of what the mechanism guarantees. `runGuarded` only dedupes concurrent calls. Before adding or changing a loader in that registration list, answer explicitly: what does this cost when it runs 30 times in two seconds? If the answer involves a network round-trip or a DOM teardown, it needs either a real cache TTL or a `skipIfPopulated`-style short-circuit.

**A `fetchData()` that opens with an unconditional `showLoading()` is a latent flicker bug.** It is harmless only as long as nothing ever calls it twice — an invariant that no code enforces and that any new refresh path silently breaks. The correct default is the `MarketBreadthPanel` shape: show loading only when nothing is rendered, show errors only when there is nothing to keep. Combined with a `cacheTtlMs: 0` breaker policy the failure is guaranteed rather than merely possible, so a zero-TTL policy should be read as a signal to audit every caller of that service's panel.

**Pin "a refetch keeps content" in a DOM test, not just "a load renders content."** The first-load assertion passes on buggy code. The test that has teeth holds a second fetch open (deferred promise) and asserts `.panel-loading` is absent while rendered content is still present. Because `showLoading` writes immediately and data writes are debounced 150 ms (`src/components/Panel.ts:142`, `:1268-1272`), such tests must control timers or they will assert against a DOM that has not committed yet.

**A browser harness must prove the code path fired.** "I scrolled and saw no bug" is only evidence if you can show the scroll reached the listener. Instrument with a counter — here, opt-in `markLcpDebug` marks (`src/utils/lcp-debug.ts`) counted before and after — and treat equal counts across the fixed and unfixed runs as the precondition for believing the outcome differs. Choosing a scroll container by "first ancestor with `scrollHeight > clientHeight`" is not reliable; verify that `scrollTop` writes stick and that events actually fire.

**Beware discriminators that are inert in the dev environment.** Local dev has no RPC endpoints, so the circuit breaker opens and network counters read zero regardless of whether the bug is present. Before trusting a metric as proof of a fix, confirm it reads *differently* on the unfixed code in the same environment — otherwise you are measuring the environment, not the change.

## Related Issues

- [deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing](../design-patterns/deduping-redundant-work-removes-the-recovery-it-was-accidentally-providing.md) — the general skip-gate pattern and its safety checklist; the `skipIfPopulated` option here is an instance of that pattern, audited against that checklist (see Why This Works).
- [panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval](panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval.md) — the inverse defect in the same App.ts prime/refresh wiring: too *few* fetches (a missing `primeTask` entry leaves the constructor's loading radar up), where this bug is too *many*.
- GitHub #5578 (feat: compose regional logistics corridor control towers) — the feature-build issue that introduced `ChinaCorridorPanel`; background only, the flicker was not reported there.
