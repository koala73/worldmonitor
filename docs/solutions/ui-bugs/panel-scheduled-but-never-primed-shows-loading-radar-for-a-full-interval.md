---
title: "A panel registered only in scheduleRefresh shows a loading radar for a full interval — App.ts needs BOTH the refresh and the prime entry"
date: 2026-08-05
category: ui-bugs
module: src/App.ts
problem_type: ui_bug
component: frontend
symptoms:
  - "A newly added panel renders the loading radar indefinitely after the user enables it — no error, no retry, no telemetry"
  - "Reproduces on 100% of first opens; the panel only populates after a full REFRESH_INTERVALS period (6h for the slow economic panels)"
  - "Every DOM/unit test for the panel passes, because they call panel.fetchData() directly — a call site production never reaches on first mount"
  - "Worse on a hidden tab or when the panel scrolls out of viewport: pauseWhenHidden stops the clock and the near-viewport predicate gates the tick"
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [panel-registration, app-ts, refresh-scheduler, prime-visible-panel-data, showloading, opt-in-panel, guardrail-test, run-immediately]
---

## Problem

Adding a panel to `src/App.ts`'s `refreshScheduler.scheduleRefresh(...)` looks like it wires up data loading. It does not. `scheduleRefresh` schedules the *next* tick, not an immediate one, so a panel registered only there sits at its loading radar until a full interval elapses — six hours for the slow economic panels.

## Symptoms

- The panel mounts and shows the loading radar forever from the user's perspective.
- No error state, no retry countdown, no console output, no telemetry — it looks like a slow feed, not a bug.
- Reproduces on essentially every first open, because opt-in panels (`enabled: false`) are only ever seen after a user enables them mid-session, which is exactly the path with no initial fetch.
- The panel's own tests are all green.

## What Didn't Work

- **Reading the scheduler registration and concluding it was wired.** `scheduleRefresh('fx', () => panel.fetchData(), REFRESH_INTERVALS.fx, () => this.isPanelNearViewport('fx'))` reads like a complete wiring. The gap is invisible at that call site — it is an *absence* somewhere else in the file.
- **Trusting the test suite.** Both a mapper suite and a DOM-behavioral suite covered the panel thoroughly, including tab switching, empty states, and the error/retry path. All of them drive the panel by calling `panel.fetchData()` directly inside their mount helper. That is a call site production never reaches on first mount, so no amount of panel-level testing can see this.
- **Assuming the lazy-mount path kicks a fetch.** `PanelLayoutManager.applyPanelSettings()` → async mount → `afterPanelMounted()` hands off to `primeVisiblePanelData()` — which is the very table missing the entry. `enablePanelById`'s own direct `fetchData()` call reads `ctx.panels[id]` synchronously, before the lazy import resolves, so it is a no-op on first enable too.

## Solution

A panel with its own `fetchData()` needs **two** registrations in `src/App.ts`, not one:

```ts
// 1. Periodic refresh — schedules the NEXT tick, not an immediate one.
this.refreshScheduler.scheduleRefresh(
  'fx',
  () => (this.state.panels['fx'] as FxPanel).fetchData(),
  REFRESH_INTERVALS.fx,
  () => this.isPanelNearViewport('fx'),
);

// 2. Initial-load kick, inside primeVisiblePanelData() — THIS is what makes
//    the panel populate on first mount.
if (shouldPrime('fx')) {
  const panel = this.state.panels['fx'] as FxPanel | undefined;
  if (panel) primeTask('fx', () => panel.fetchData());
}
```

`{ runImmediately: true }` on `scheduleRefresh` also fires an initial fetch, but it bypasses the `visiblePanelPrimed` / `inFlight` dedupe the rest of the prime table relies on. Prefer the `primeTask` block — it is what all ~27 sibling panels do.

## Why This Works

Three mechanisms have to line up, and only the prime table closes the gap:

1. `Panel`'s constructor calls `showLoading()` — so a freshly mounted panel is *always* in the loading state until something calls its fetch.
2. `scheduleRefresh` passes `runImmediately: options.runImmediately ?? false` into the poll loop, which therefore takes its `scheduleNext()` branch. The first fire is one full interval away.
3. `primeVisiblePanelData()` is the sole near-viewport kickoff path, and it is keyed by an explicit per-panel entry.

The repo already documents this in `src/App.ts`, in a comment written after the same bug hit the Energy Atlas panels:

> primeTask wires the panels sit at showLoading() forever because Panel's constructor calls showLoading() but nothing else triggers fetchData() on attach — App.ts's primeTask table is the sole near-viewport kickoff path.

The comment existed and the trap still recurred, which is the argument for a mechanical guard rather than prose.

## Prevention

The invariant is checkable and held for all 27 timer-refreshed panels, so it is now a build failure. Added to `tests/panel-config-guardrails.test.mjs`:

```js
it('every panel refreshed on a timer is also primed on first mount', () => {
  const scheduled = [...appSrc.matchAll(
    /scheduleRefresh\(\s*'([a-z0-9-]+)',\s*\(\)\s*=>\s*\(this\.state\.panels\['[a-z0-9-]+'\][^)]*\)\.fetchData\(\)/g,
  )].map((m) => m[1]);
  const primed = new Set([...appSrc.matchAll(/primeTask\('([a-z0-9-]+)'/g)].map((m) => m[1]));

  // Sanity floors: a source-regex guard whose pattern silently stops matching
  // passes vacuously, which is the failure mode it exists to prevent.
  assert.ok(scheduled.length >= 20, `matched only ${scheduled.length} scheduled panels — the scheduleRefresh pattern broke`);
  assert.ok(primed.size >= 20, `matched only ${primed.size} primeTask entries — the primeTask pattern broke`);

  assert.deepStrictEqual(scheduled.filter((id) => !primed.has(id)).sort(), [], '...');
});
```

Two things make this guard trustworthy rather than decorative:

- **The sanity floors.** A source-regex guard is the classic vacuous test — when the pattern stops matching (a refactor changes the call shape), it silently passes on an empty set. Asserting a minimum match count converts that into a loud failure.
- **It was mutation-proved.** Deleting the `shouldPrime('fx')` block turns the test red with the offending panel named. A guard that has never been observed failing is not yet a guard.

Review notes for this class of bug:

- When a change adds a panel, diff its registration surface against a recent sibling (`bigmac`, `fuel-prices`, `consumer-prices`) and list every place the sibling appears but the new panel does not. Three independent reviewers found this gap that way; none found it by reading the new code alone.
- Treat "all the panel's own tests pass" as no evidence at all about *initial load*, whenever the tests invoke the fetch entry point directly.
