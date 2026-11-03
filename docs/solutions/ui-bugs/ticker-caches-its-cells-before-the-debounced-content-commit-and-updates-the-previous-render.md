---
title: "Bind row handles in the setSafeContent commit callback, not after render() returns, or the Global Debt Clock ticker updates the loading placeholder"
date: 2026-09-06
category: ui-bugs
module: src/components/NationalDebtPanel.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Global Debt Clock figures freeze after the panel's first load. The per-second counters never advance on a panel enabled by default at priority 2"
  - "Sorting, searching, or clicking load-more makes the numbers start ticking, so the failure reads as intermittent and self-healing rather than as a bug"
  - "No console error, no failed request, no Sentry event. The 1000 ms setInterval fires on schedule against an empty element cache and writes nothing"
  - "The suite named after the feature was green throughout. It held local copies of getCurrentDebt and formatDebt and passed with no production file present"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [debounced-content-commit, setsafecontent, afterupdate-callback, cached-element-handles, ticker-lifecycle, national-debt-panel, panel-lifecycle, happy-dom-regression-test]
---

# Bind row handles in the setSafeContent commit callback, not after render() returns, or the Global Debt Clock ticker updates the loading placeholder

## Problem

The Global Debt Clock panel never ticked after its first load. Per-country and global figures rendered once and then stood still, so a panel whose entire product promise is a live-accruing counter looked frozen until the user touched it.

The panel is enabled by default at priority 2 in the full variant (`src/config/panels.ts:130`), so every dashboard user saw the dead clock.

## Symptoms

- The `.debt-ticker` cells and the `.debt-global-ticker` element held their first-render values indefinitely. The 1 s interval was running and writing nothing.
- Clicking a sort tab, typing in the search box, or pressing load-more made the clock start ticking. Those handlers re-rendered against markup that was already committed, so the element cache bound to real rows.
- Nothing logged an error. `startTicker()` bails silently when `querySelector` finds no rows (`src/components/NationalDebtPanel.ts:375`), so the failure had no signal at all.
- The unit suite named after this exact feature was green the whole time.

## What Didn't Work

There was no debugging dead end here. The failure was invisible because the test that claimed to cover it could not see production at all. In the project's vocabulary it was a Vacuous Guard: a harness that never supplied the input its assertion was written about.

- **The old suite tested copies, not the panel.** `tests/national-debt-ticker.test.mts`, which PR #7807 deletes and which exists only on main before that PR, defined its own local `getCurrentDebt` and `formatDebt` at the top of the file and asserted against those. It imported nothing from `src/`. Issue #7770 proved the whole file still passed when every production file was removed from the directory.
- **The copies had already drifted.** The local `getCurrentDebt(entry, nowMs)` took the clock as an argument. The panel reads `Date.now()` itself and guards a missing `baselineTs` or a missing `perSecondRate`. A test that hands in its own timestamp can never observe whether the panel reads the clock, let alone whether anything writes the result to the DOM.
- **Math coverage was never the gap.** The arithmetic was correct before and after the fix. The defect lived entirely in the ordering between the render commit and the element-handle cache, which is a DOM-lifecycle fact that no pure-function test can reach.

Once the replacement test rendered the real panel and read the cells, the ordering bug was immediate. No other hypothesis was tried.

## Solution

`render()` now owns the ticker lifecycle and starts it from the commit callback.

Before, on main before PR #7807:

```ts
// render()
this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));

// refresh()
this.render();
this.startTicker();

// click and input handlers, three call sites
this.render();
this.restartTicker();
```

After, at the end of `render()` (`src/components/NationalDebtPanel.ts:338` to `:343`):

```ts
// The ticker caches the cells it updates and setSafeContent commits
// through a debounce, so the cache must be rebuilt after the commit, not
// when this call returns. Starting it here (rather than after render() at
// each call site) is what makes the clock tick after the first load: the
// old ordering cached against the loading placeholder and found no rows.
this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'), () => this.startTicker());
```

The empty-entries branch stops the ticker explicitly before painting the error state (`src/components/NationalDebtPanel.ts:294`):

```ts
if (this.entries.length === 0) {
  this.stopTicker();
  this.showError('No data available');
  return;
}
```

The call-site `startTicker()` in `refresh()`, the three `restartTicker()` calls in the click and input handlers, and the `restartTicker()` method itself were all deleted.

## Why This Works

`Panel.setSafeContent` does not touch the DOM when you call it. It forwards to `setContentHtml` (`src/components/Panel.ts:1458` and `src/components/Panel.ts:1472`), which stores the markup as `pendingContentHtml`, stores the callback as `pendingContentCallback`, and arms a timer (`src/components/Panel.ts:1502`). The delay is `contentDebounceMs`, a private readonly field set to 150 (`src/components/Panel.ts:143`). Only when that timer fires does `setContentImmediate` write the markup into `this.content`, and it invokes the saved callback on the line after the write (`src/components/Panel.ts:1525` and `src/components/Panel.ts:1531`). The concept map calls this deferred moment the Content Commit.

So on first load the old sequence was: `refresh()` paints the loading placeholder through `showLoadingState()`, `render()` queues the row markup behind the 150 ms timer, and `startTicker()` then runs synchronously against a `this.content` that still holds the placeholder. Its `querySelector` calls for `.debt-global-ticker` and each `.debt-ticker[data-iso3=...]` return null, `tickerElements` stays empty, and the interval it starts iterates an empty map once a second forever.

The later user-driven re-renders worked by accident. By the time a sort tab or the search box fired, the row markup had long since committed, so `restartTicker()` found real cells. The bug was invisible precisely to the interactions a person performs while looking for it.

Two details make the commit callback the only correct place, not merely a tidier one.

- The dirty-check short-circuit still honors the callback. When the candidate markup equals `lastCommittedHtml`, `setContentHtml` cancels any queued write and calls `afterUpdate` synchronously before returning (`src/components/Panel.ts:1480` to `src/components/Panel.ts:1488`). A re-render that produces byte-identical markup therefore still rebinds the handles rather than skipping them.
- A cancelled write drops its callback. `showError` and the other immediate paint paths route through `replaceContent`, which calls `cancelPendingContentWrite` (`src/components/Panel.ts:1403`), and that clears `pendingContentCallback` along with the pending markup (`src/components/Panel.ts:1272`). A queued `startTicker` is therefore silently discarded if an error paint lands inside the debounce window. That is why the empty branch must call `stopTicker()` itself: no callback will ever run to do it, and a previously running interval would otherwise keep writing into detached nodes that `replaceChildren` has already swapped out.

The comment inside that dirty-check branch records an earlier instance of the same class of failure. It describes World Clock losing its tick because a stale debounced write strands the cached row handles (`src/components/Panel.ts:1480` to `src/components/Panel.ts:1488`). The debt clock reached the same dead state by a different route.

## Prevention

**Rule 1. `render()` is the single owner of anything bound to rendered rows.** If a Panel subclass caches element handles, starts a timer, or attaches an observer that depends on the markup it just produced, that registration belongs in the `afterUpdate` callback of `setSafeContent`, and nowhere else. Do not start it after `render()` returns, and do not add a second start at the call sites. `WorldClockPanel` is the reference implementation: the `setSafeContent` call at `src/components/WorldClockPanel.ts:386` passes `() => this.cacheClockRefs(sorted)` on line 388, and the two-line comment above the call states the reason.

**Rule 2. Never read `this.content` synchronously after `setSafeContent`.** The debounced path means the DOM you query is the outgoing subtree. If you need the content immediately, `setSafeContentImmediate` (`src/components/Panel.ts:1468`) commits without the timer, and `setTrustedContent` and `setContentNodes` also write immediately.

**Rule 3. Pair every start with an explicit stop on the branches that do not commit.** Error and empty branches paint through paths that cancel the pending callback, so the callback that would have stopped your timer never runs.

**Rule 4. Test the panel, not a copy of its math.** A DOM test must advance fake timers past the 150 ms debounce before asserting on rendered content, then advance again to observe the timer under test. The pattern from `tests/dom/national-debt-ticker.test.mts`:

```ts
const CONTENT_DEBOUNCE_MS = 150;

async function load(entries: NationalDebtEntry[]): Promise<void> {
  mockGetNationalDebtData.mockResolvedValueOnce(response(entries));
  await panel.refresh();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

it('ticks the rendered cells every second without a re-render', async () => {
  await load([entry({ iso3: 'TCK', debtUsd: 999_500_000_000, perSecondRate: 1_000_000_000 })]);
  expect(tickerText('TCK')).toBe('$999.5B');
  vi.advanceTimersByTime(TICK_MS);
  expect(tickerText('TCK')).toBe('$1.0T');
});
```

The load helper is what makes the suite honest. Assert the first value, advance one tick, assert it changed, and never re-render in between. A test that re-renders before its second assertion passes on the broken code. This case is the Mutation Proof for the fix: it was red on main and green on the branch.

**Rule 5. A suite that imports nothing from `src/` proves nothing.** The check that caught this was mechanical: copy the test file into an empty directory and run it. If it passes, it is testing itself. That check is what issue #7770 applied across four suites.

## Related Issues

- **Issue #7770** replaced four suites that passed with no production files present. It is the origin of this find and is open as of 2026-09-06.
- **PR #7807**, "test(coverage): replace four copied suites with production-bound tests; fix the debt clock ticker", carries the fix on branch `test/copied-suites-7770` and closes #7770. It is open and unmerged as of 2026-09-06. Its own evidence records that the new case failed against main as shipped with `expected '$999.5B' to be '$1.0T'`. The six cases in `tests/dom/national-debt-ticker.test.mts` were confirmed green on the fix branch during this session.
- **PR #7789** (closing issue #7775) added `setSafeContentImmediate` so the Heatmap tab commits without the coalescing timer. It is an earlier, independent case of the same 150 ms window hurting a user-visible interaction, and it produced no solutions doc.
- [Scroll re-prime of a zero-TTL panel flickers the loading radar](./scroll-reprime-of-a-zero-ttl-panel-flickers-the-loading-radar.md) is the closest sibling. It dissects the same write asymmetry from the opposite side: there an immediate loading paint erased committed content, here a handle cache was built before the debounced commit ran. Its prevention section already states the DOM-test half of Rule 4.
- [A deferred panel mounts after the boot data pass and keeps its constructor's empty state](./deferred-panel-mounts-after-the-boot-data-pass-and-keeps-its-constructor-empty-state.md) carries the same warning to assert only after the debounce drains, for a different root cause in the same panel-lifecycle family.
- [StatusPanel is a detached data sink](./digest-coverage-row-renders-into-a-never-mounted-statuspanel.md) is the same test blind spot one layer over: a component test that reads the element straight out of the component passes against a DOM state production never has.
- [Panel scheduled but never primed shows the loading radar for a full interval](./panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval.md) has the same "green tests, dead panel" shape and shows the guardrail-test remedy that would mechanise Rule 1 across every Panel subclass.
- [Prove what the sanctioned helper adds, not what the refactor preserves](../conventions/prove-what-the-sanctioned-helper-adds-not-what-the-refactor-preserves.md) documents the Panel content-write helper family and the pending-write model this doc relies on.
- The Panel Event Delegation Pattern section of [docs/architecture.mdx](../../architecture.mdx) states the hazard for event listeners and prescribes delegation on the stable content container. Delegation does not protect a cached row handle, a timer that walks cached cells, or an observer over rendered rows, which is what Rule 1 adds.
- **`tests/national-debt-panel-refresh.test.mts`** covers the adjacent detached-mount work on the same panel: the bounded retry while detached, the single load after the lazy element connects, the MutationObserver refresh, and observer teardown on destroy. It is a sibling lifecycle concern and is unaffected by this fix, which is why it stayed a non-DOM suite.
- **`src/components/StrategicPosturePanel.ts` is a suspected instance of the same ordering defect and should be verified.** `showLoading()` queues its markup through `setSafeContent` at line 60, and `showLoadingStage('aircraft')` at line 143 queries `.posture-stage` out of `this.content` at line 110. If the first stage call lands inside the 150 ms window, `stages.length === 0` and the function returns silently, so the first stage indicator never lights. The later vessels and analysis calls sit behind network awaits and probably land after the commit, and the elapsed-time interval re-queries on every tick rather than caching, so it self-heals. The suspected impact is cosmetic and limited to the first loading stage. This has not been reproduced.
- The World Clock regression recorded in the comment at `src/components/Panel.ts:1480` is the prior occurrence of stranded row handles. It arrived through a stale queued write rather than an early cache, which is worth noting because it means the hazard has more than one entry point.
