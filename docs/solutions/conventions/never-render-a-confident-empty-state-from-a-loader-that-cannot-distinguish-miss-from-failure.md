---
title: "Never render a confident empty state from a loader that cannot distinguish a miss from a failure"
date: 2026-08-05
category: conventions
module: src/services/bootstrap.ts
problem_type: convention
component: frontend
applies_when:
  - "A client loader swallows fetch/timeout/parse errors and returns a single 'nothing' value such as undefined or null"
  - "A panel or view decides between rendering data and rendering an empty state based on that value"
  - "The data source is one whose genuinely-empty state is implausible (a rates table, a country list, a fixed catalogue)"
tags: [empty-state, error-handling, ensure-hydrated, bootstrap, retry, honesty, hit-miss-failure, panel-ux]
---

## Context

`ensureHydrated(key)` in `src/services/bootstrap.ts` is the client's on-demand loader for bootstrap-tier cache keys. It is written to never throw: a failed response, a 10s timeout, and a JSON parse error all resolve to `undefined`, the same value returned for a legitimate cache miss.

That is a reasonable contract for a loader — callers do not want to write try/catch around every read. But it means **the caller cannot tell "there is no data" from "we could not find out."** A view that maps `undefined` onto a confident "No data" empty state is therefore asserting something it does not know.

The repo already names this distinction in `CONCEPTS.md` as hit / miss / failure; the trap is that the loader's return type collapses two of the three.

## Guidance

When a view's empty state is driven by a loader that collapses miss and failure, decide which of these is true and render accordingly:

- **A genuinely-empty result is plausible** (a user's saved searches, a filtered list, an alerts feed on a quiet day) — an empty state is honest. Render it.
- **A genuinely-empty result is implausible** (an FX rates table, a country registry, a fixed catalogue) — "nothing came back" is overwhelmingly likely to be an outage. Render the *failure* state, which in this codebase means `showError(...)` with a retry callback.

The second case is easy to get wrong because the empty state feels like the safer, calmer choice. It is not: it is a claim, and it also **skips the recovery path**.

```ts
// Three independent sources all returning nothing is an outage, not an empty
// feed — there is no world in which 45 currencies, 47 USD rates and 7 ECB pairs
// are all legitimately absent. `ensureHydrated` swallows fetch, timeout and JSON
// errors into `undefined`, so a dead bootstrap is indistinguishable from a miss
// at this layer; reporting "No data" would state as fact something we cannot
// know, and would skip the retry that recovers it.
if (!this.hasStress() && !this.hasSpot()) {
  this.showError(t('common.failedMarketData'), () => void this.fetchData());
  return;
}
```

## Why This Matters

Two costs, and the second is the one that actually hurts users:

1. **The claim is false.** "No data" tells the reader the upstream has nothing. During an outage that is simply untrue, and it is the kind of wrong that never gets reported as a bug — it looks like a working panel with an unlucky feed.
2. **It disables recovery.** In this codebase the empty state is terminal, while `Panel.showError(msg, onRetry)` schedules an auto-retry with exponential backoff (first fire at 15s). Choosing the empty state means the panel stays wrong until the next scheduled refresh — up to six hours for slow panels — even though the outage may clear in seconds.

There is a third, subtler cost: an empty-state branch that production can never legitimately reach is dead code that still has to be read, tested, and maintained.

## When to Apply

Apply whenever **both** hold:

- The loader cannot distinguish miss from failure. In this repo that includes `ensureHydrated`, and any service wrapping a call in `try { ... } catch { return undefined }` or a circuit breaker whose fallback is an empty payload.
- The data's empty state is implausible enough that "all of it is missing" is better explained by an outage than by reality.

Do **not** apply it to genuinely-optional data — turning a quiet alerts feed into a red error state is the opposite failure.

When the loader *can* distinguish the two, the better fix is to preserve that distinction through the return type rather than inferring it downstream.

## Examples

**Before** — a confident claim the code cannot support, and no retry:

```ts
if (!this.hasStress() && !this.hasSpot()) {
  this.setSafeContent(safeHtml`<div class="panel-empty">${t('common.noDataShort')}</div>`);
  return;
}
```

**After** — the failure state, which is both honest and self-healing:

```ts
if (!this.hasStress() && !this.hasSpot()) {
  this.showError(t('common.failedMarketData'), () => void this.fetchData());
  return;
}
```

**Locking it** — assert the retry actually fires, not merely that the panel looks broken:

```ts
await mount(rows({ yoy: { rates: [] }, usd: {}, ecb: [] }));
expect(panel.getElement().querySelector('.panel-error-state')).not.toBeNull();
expect(panel.getElement().querySelector('.panel-empty')).toBeNull();

// and it must actually retry, not just look broken
expect(panel.getElement().querySelector('.panel-error-countdown')).not.toBeNull();
mockGetFxPanelData.mockResolvedValue(rows());
await vi.advanceTimersByTimeAsync(16_000);
expect(dataRows()).toHaveLength(3);
```

The countdown assertion is the load-bearing one: `Panel.showError` only schedules a retry when a callback was passed, so an error state without it is a dead panel that merely *looks* like it is recovering.
