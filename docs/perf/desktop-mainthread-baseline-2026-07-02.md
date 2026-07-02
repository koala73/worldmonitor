# Desktop main-thread baseline — 2026-07-02 (#4539 / #4487)

The committed **desktop** main-thread attribution + methodology — the twin of the mobile baseline
(`docs/perf/mobile-mainthread-baseline-2026-06-27.md`, #4458). It exists to answer the meta-gap in
#4539: on desktop `/dashboard`, **52% (~11 s) of main-thread time was an uncharacterized "Other"
bucket**, and the open byte/boot-split campaign (scriptEval) demonstrably wasn't where the time was.
You can't fix what isn't attributed — this baseline attributes it.

## How to measure

Two complementary signals (KTD1, same as mobile — local lab **absolutes** are host-contention
contaminated: #4486 recorded the same URL scoring 28/57/85, so trust the **relative** split and take
authoritative absolutes from PageSpeed/Calibre):

1. **Authoritative absolute timings → PageSpeed Insights / Calibre** (clean infra, zero local
   contention). Median of ≥3; discard the first-run outlier.
2. **Deterministic relative decomposition → `scripts/measure-desktop-mainthread.mjs`** (this
   harness). Unlike the mobile harness (which attributes *long tasks by container*), this captures a
   Chrome DevTools performance **trace** via CDP and aggregates renderer main-thread **self-time by
   trace-event name → category**, then **itemizes the "Other" bucket by event name** — which is the
   whole point, since Lighthouse's coarse `mainthread-work-breakdown` reports "Other" as a black box.

```bash
# unthrottled desktop (matches Lighthouse desktop, cpuSlowdown 1x)
node scripts/measure-desktop-mainthread.mjs https://www.worldmonitor.app/dashboard --cpu 1 --settle 15000 --json
# throttled cross-check (surfaces long-task structure; relative shares should hold)
node scripts/measure-desktop-mainthread.mjs https://www.worldmonitor.app/dashboard --cpu 4 --settle 15000 --json
```

> The pure attribution functions (`normalizeCompleteEvents`, `pickRendererMainThread`,
> `computeSelfTimeByName`, `categorize`, `buildDecomposition`) are exported and unit-tested with a
> deterministic fixture (`tests/measure-desktop-mainthread.test.mts`) — CI-safe, no browser.
> Self-time = a trace node's duration minus its direct children's, summed by event name.

## Harness capture — 2026-07-02 (prod, post #4556/#4558/#4561/#4600)

`scripts/measure-desktop-mainthread.mjs` vs `https://www.worldmonitor.app/dashboard`, 1350×940
desktop, 15 s settle. Self-time total is **not** the same metric as Lighthouse's ~21 s wall
`mainthread-work` (which includes idle-thread wall time); it is the summed attributed self-time.

### Category split (the reproduction check)

| Category | Unthrottled (cpu 1) | Throttled (cpu 4) | Prior lab (#4487) |
|---|---|---|---|
| **other** | **54.8%** (6.08 s) | 42.3% | ~52% |
| **styleLayout** (forced reflow → #4536) | **20.9%** (2.32 s) | 18.8% | ~19% |
| scripting | 13.1% (1.46 s) | 30.4% | ~19% (script-eval) |
| paintComposite | 10.8% (1.20 s) | 7.6% | — |
| parseHTML | 0.4% | 0.8% | — |
| garbageCollection | ~0% | ~0% | — |
| main-thread self-time total | 11.1 s | 14.4 s | ~11.1 s "Other" / 21.3 s work |
| long tasks (>50 ms) / TBT | 14 / 683 ms | 184 / 8568 ms | — |

The unthrottled split matches the prior lab's 52/19/19 almost exactly, which validates the harness.
Throttling amplifies `scripting` (JS eval scales with CPU slowdown) but the **structure** holds.

### "Other" decomposed — the #4539 black box, cracked open

| "Other" component | cpu 1 | cpu 4 | What it is |
|---|---|---|---|
| **`Layerize`** | **27.6%** (3.06 s) | 15.5% | **Compositor layerization** — assigning paint layers to compositing layers. Cost scales with the number of composited layers and how often the layer tree is rebuilt. |
| `ThreadControllerImpl::RunTask` | 20.4% (2.27 s) | 16.5% | Scheduler task-runner self-time — the cost of *running many tasks*. Largely irreducible; shrinks as task count drops (what the boot-split/INP work already targets). |
| `IntersectionObserverController::computeIntersections` | 2.2% (0.25 s) | 1.4% | IO callbacks (the panel-mount observers). |
| `UpdateLayer` + GC scavenger + mojo + v8 housekeeping | ~3% | ~3% | Small, expected. |

## Findings

1. **`Layerize` (compositor layerization) is the single largest previously-uncharacterized cost —
   ~27.6% / 3.06 s of desktop main-thread, ~half of all "Other".** It is stably a top-2 "Other"
   component across both host conditions (27.6% unthrottled / 15.5% throttled), so it is a real
   structural cost, not a host artifact. Lighthouse buckets `Layerize` into "Other," which is
   exactly why the 52% was a black box. **This is the concrete new lever (follow-up filed).**
2. **~20% of "Other" is scheduler `RunTask` self-time** — the raw cost of running many main-thread
   tasks. This is not a discrete bug to fix; it falls as the open boot-split (#4486 line) and INP
   handler-chunking (#4537/#4556/#4558/#4617) reduce task count. It should not be chased separately.
3. **The "9 s document task with 60 ms script-eval" (issue signal) is explained.** It is
   `styleLayout` (2.3 s forced reflow) + `Layerize` (3 s compositing) + scheduler running
   synchronously during initial render — **layout + compositing, not app JS.** This corroborates
   #4536 (forced reflow) and points the remaining desktop render axis at compositing, not scriptEval.

## Concrete follow-up (acceptance: ≥1 sized lever)

- **Reduce compositing-layer count / `Layerize` churn** — the ~3 s / 27.6% lever surfaced above.
  Investigation path (CDP `LayerTree` domain to count composited layers; audit `will-change`,
  `transform: translateZ()`/3D transforms, `position: sticky/fixed`, opacity/filter on large
  subtrees, and per-panel layer promotion that forces extra compositing layers beyond the two
  unavoidable map canvases). Filed as **#4630** (linked from #4539).

## Gate / re-measure

Re-run both harness invocations before/after any compositing-layer change and record the
`Layerize` self-time share delta in the PR. Take the authoritative absolute desktop `mainthread-work`
from a clean PSI/Calibre run — this harness supplies the **relative** decomposition, not the headline
absolute (KTD1). The `styleLayout` share is the #4536 gate; the `Layerize` share is the new one.
