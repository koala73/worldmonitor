# Mobile main-thread baseline — 2026-06-27 (#4443 / U2)

The committed baseline and measurement methodology for mobile main-thread performance.
Every follow-up change compares against this document.

## How to measure

Two complementary signals (KTD1 — local mobile Lighthouse is untrustworthy: its `simulate`
throttling 4×-amplifies host-CPU contention; the same URL has scored 28/57/85):

1. **Authoritative absolute timings → PageSpeed Insights** (`pagespeed.web.dev`, mobile, Google
   infra, zero local contention). Take the **median of ≥3** runs; discard the first-run outlier.
   This is the headline TBT / `mainthread-work` / `bootup-time` / `scriptEvaluation` /
   `styleLayout` and the per-script `bootup-time` ranking (R4).
2. **Deterministic relative decomposition → `scripts/measure-mobile-mainthread.mjs`** (this
   harness; Playwright mobile emulation + CPU throttle). It now captures a Chrome DevTools trace
   and aggregates renderer main-thread self-time by event name → category, itemizing the
   Lighthouse "Other" bucket the same way the desktop harness did for #4539. It also retains the
   long-task and DOM-node signals used by the original R3 gate (reduce vs. reorder).

```bash
# deterministic harness (best-effort live capture)
node scripts/measure-mobile-mainthread.mjs https://worldmonitor.app/dashboard --cpu 4 --settle 14000
# or against a local preview: node scripts/measure-mobile-mainthread.mjs http://127.0.0.1:4173/dashboard
```

> **Per-script chunk ownership still comes from Lighthouse, not this script.** The browser
> `PerformanceObserver("longtask")` attribution API returns `unknown`/`self` for first-party
> same-origin script, so the harness cannot name *which* chunk owns each long task. The local trace
> path decomposes native main-thread event names/categories (`Layerize`, `RunTask`, layout, paint,
> GC, etc.) and itemizes `Other`; for the per-script ranking (Map-*.js, main.js, panel-layout),
> still use Lighthouse `bootup-time`, as #4443 did.

## Committed PSI baseline (the comparison point)

From #4443 — prod mobile Lighthouse, 2026-06-26, ×3 median (post #4425 + #4431; before this roadmap):

| Metric | Baseline | Umbrella target (−33%) |
|---|---|---|
| TBT | ~1.5 s | ≤ ~1.0 s |
| `mainthread-work` | ~15 s | ≤ ~10 s |
| `bootup-time` | ~3.2 s | — |
| `scriptEvaluation` | ~3.7 s | — |
| `styleLayout` | ~1.3 s | — |
| Lighthouse Perf (mobile) | ~65 | lift |

Per-script `bootup-time` (mobile, #4443): `Map-*.js` ~880 ms · `main.js` ~650–1200 ms ·
`panel-gating` (= `createPanels` serialization in `panel-layout`, not `panel-gating.ts`) ~447 ms.

> **PSI mobile is blocked (2026-06-27):** the unkeyed PageSpeed API is quota-exhausted (429) and
> the repo `GOOGLE_API_KEY` is expired (400). Re-take a fresh PSI mobile median-of-3 at
> `pagespeed.web.dev` (or renew the key) before Phase B/C and paste it here:
>
> | Metric | PSI mobile (median-of-3, date) |
> |---|---|
> | TBT | _pending PSI_ |
> | `mainthread-work` | _pending PSI_ |
> | `bootup-time` | _pending PSI_ |

**Interim desktop-Lighthouse baseline** (2026-06-27, current prod = post #4442/#4448, before the
Phase A/B/C PRs land; `npx lighthouse@12 --preset=desktop`, median-of-3). Per KTD1, local *desktop*
Lighthouse is the reliable fallback when PSI mobile is unavailable; mobile TBT is extrapolated as
desktop × ~4. **These runs were host-contended** (score swung 51–77), so treat absolute TBT as
directional:

| Metric | Desktop median (range) | Mobile estimate (×4) |
|---|---|---|
| Perf score | 62 (51–77) | — |
| TBT | 562 ms (287–696) | ~2.2 s |
| `mainthread-work` | 10.1 s (8.1–11.1) | — |
| `bootup-time` | 1.8 s (1.3–1.9) | — |
| FCP / LCP | 1.1 s | — |

Reading: `mainthread-work` ~10 s and `bootup-time` ~1.8 s remain the dominant budget (paint is fine
at ~1.1 s) — consistent with the script-execution-bound finding above. Desktop TBT is noisy under
contention; the authoritative mobile TBT still needs a clean PSI run.

## Harness capture — 2026-07-03 (prod, mobile trace decomposition)

Command:

```bash
node scripts/measure-mobile-mainthread.mjs https://worldmonitor.app/dashboard --cpu 4 --settle 14000 --json
```

First local capture, iPhone 14 Pro Max emulation, CPU 4×, 14 s settle. As above, treat absolute
ms as host-contended lab values and use the relative split to decide what bucket to investigate.

| Category | Share | Self-time |
|---|---:|---:|
| scripting | 50.7% | 7.52 s |
| **other** | **31.9%** | **4.73 s** |
| styleLayout | 12.1% | 1.80 s |
| paintComposite | 4.8% | 0.71 s |
| parseHTML | 0.4% | 0.05 s |
| garbageCollection | 0.1% | 0.02 s |
| main-thread self-time total | — | 14.82 s |
| long tasks (>50 ms) / TBT | 63 / 10.74 s | — |

A second same-command capture after the reuse cleanup was materially consistent: scripting 49.4%,
`other` 31.7%, styleLayout 13.2%, `ThreadControllerImpl::RunTask` 9.7%,
`SimpleWatcher::OnHandleReady` 7.0%, and `Layerize` 3.3%.

### Mobile "Other" decomposed

| "Other" component | Share | Self-time | What it suggests |
|---|---:|---:|---|
| `ThreadControllerImpl::RunTask` | 9.7% | 1.44 s | Scheduler task-runner self-time from running many renderer tasks. |
| `SimpleWatcher::OnHandleReady` | 6.4% | 0.95 s | Chromium handle/socket readiness work; likely network or async plumbing around startup. |
| `RunTask` | 3.7% | 0.55 s | More scheduler wrapper self-time. |
| `Layerize` | 2.2% | 0.33 s | Compositor layerization; much smaller on mobile than desktop #4539. |
| `v8.run` | 1.9% | 0.28 s | V8 native wrapper overhead; chunk ownership still comes from Lighthouse `bootup-time`. |
| `IntersectionObserverController::computeIntersections` | 1.0% | 0.14 s | Panel mount / visibility observer work. |

Findings from this run:

1. The old mobile "Other" bucket is no longer a black box. In this current prod capture it is
   **scheduler + Chromium watcher dominated**, not primarily compositor `Layerize` as on desktop.
2. The largest total category is still **scripting** under CPU 4× (50.7% / 7.52 s). Use Lighthouse
   `bootup-time` to map that to chunks; this harness maps native event categories and `Other`.
3. DOM-node attribution remains close to the 2026-06-27 conclusion: panels 830 / 42.1%, map SVG
   250 / 12.7%, total 1,971 nodes.

## Harness capture — 2026-06-27 (prod, post #4442/#4448)

`scripts/measure-mobile-mainthread.mjs` vs `https://worldmonitor.app/dashboard`, iPhone 14 Pro Max
emulation, CPU 4×, 14 s settle, n=3:

| Signal | Sample 1 | Sample 2 | Sample 3 | Notes |
|---|---|---|---|---|
| Long tasks (>50 ms) | 9 | 7 | 8 | counted by the observer during settle |
| Total long-task ms | 1164 | 1011 | 1052 | — |
| **Script-TBT ms** | 714 | 661 | 652 | **median ~661** — *relative* signal, NOT comparable to PSI TBT (different metric basis/throttle/host) |
| **DOM nodes (total)** | **2313** | **2313** | **2313** | **perfectly stable** (deterministic) |
| └ panels (`.panel`) | 960 (41.5%) | 960 | 960 | largest attributed source |
| └ map SVG (`#mapContainer svg`) | 314 (13.6%) | 314 | 314 | — |
| └ other (chrome/header/shells) | ~1039 (44.9%) | — | — | derived |

Node counts are **unique** (each element counted once, via `querySelectorAll('.panel, .panel *')`),
so nested panels can't inflate the total. Re-verified after that fix: total 2319, panels 971
(41.9%), map 314 (13.5%) — within run-to-run content variance of the table above, so the
panels-dominate-map conclusion is robust to the counting method.

## Findings (R4 ranking + corrections to the plan's expected order)

1. **DOM-node attribution confirms the plan's premise-correction direction, but the ~33K basis is
   wrong for mobile-initial.** Mobile **initial** DOM (no scroll) is **~2.3K**, not ~33K — because
   mobile mounts only the initial panel budget (4) plus IntersectionObserver shells. The ~33K /
   "map ~1–1.5K" figures in #4443 are a **desktop or fully-scrolled** count. On the boot-critical
   mobile-initial state: **panels are the largest single attributed source (~960, 41.5%, ~3× the
   map's 314)** — so U4/U5 (panels) remain the node-count levers, but the absolute target is
   ~2.3K, not 33K. → **re-derive the 33K basis** (desktop vs. fully-scrolled) before sizing U4/U5.
2. **The dominant mobile-boot cost is script execution, not node count.** ~7–9 long tasks totalling
   ~1.0–1.2 s of attributed main-thread time on a ~2.3K-node page points at `scriptEvaluation`
   (Map.ts geometry build + `createPanels` serialization + main.js), consistent with #4443's
   `bootup-time` ranking. → **U3 (de-serialize/chunk createPanels) and U6 (110m geometry) are the
   highest-leverage levers**; U4/U5 (node count) are secondary on the mobile-initial state.
3. **Script-TBT is stable enough to gate on.** ~652–714 ms across n=3 (range ~9%); DOM-node counts
   are exact. Both are usable per-PR R3 signals; PSI supplies the absolute headline.

### Lever ranking for Phase B/C (current evidence; confirm with a fresh PSI bootup-time pass)

1. **U3** — `createPanels` de-serialization/chunking (the ~447 ms `panel-layout` block).
2. **U6** — mobile 110m topology (cuts `Map.ts` geometry parse/`styleLayout`; deterministic, U2-independent).
3. **U7** — feature caps + skip the first-paint label-reflow loop (`styleLayout`).
4. **U4 / U5** — panel node-count levers; smaller absolute target on mobile-initial than the plan assumed (see finding 1).
5. **U8** — canvas dense layers; **gated** — only if post-U6+U7 map `styleLayout`/compositor residual clears the bar (likely low value given the small mobile-initial map-node share).

## Gate status (R5)

U2 is the binding gate. Before each Phase B/C PR: (a) re-take PSI median-of-3 here if stale,
(b) run the harness before/after and record the script-TBT + DOM-node delta in the PR, (c) honor
the per-unit drop thresholds in the plan (defer U3 if `createPanels` < ~150 ms attributed; defer
U8 if the post-U6+U7 residual is below its bar).
