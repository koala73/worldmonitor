---
title: "/pro LCP landed at React mount because the hero outgrew the static crawler block"
date: 2026-10-16
category: performance-issues
module: pro-test (prerender.mjs, App.tsx)
problem_type: performance_issue
component: frontend_stimulus
symptoms:
  - "DebugBear alert: Mobile /pro LCP 656 -> 838 ms (+28%) on 67 page views per window"
  - "Desktop /pro RUM p75 LCP 1,420 ms against a p75 FCP of 572 ms"
  - "LCP element `#root h1.text-6xl` on 393 of 708 desktop views, p75 1,724 ms"
  - "Most other RUM rows report lcpSelector null"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [lcp, largest-contentful-paint, debugbear, rum, prerender, createroot, critical-css, cascade-layers, pro-page, hero]
---

# /pro LCP landed at React mount because the hero outgrew the static crawler block

## Problem

The static HTML for `/pro` held only a curated crawler block. `pro-test/src/main.tsx:49` then calls `createRoot(rootElement).render(...)`, which replaces that block with the React page. At widths of 768 px and up, the React hero `<h1>` was larger than anything painted before it. The browser therefore recorded a new LCP entry when the bundle mounted, 1.8–2.4 s after first paint. Fixed in PR #9175.

## Symptoms

- A DebugBear RUM alert reported mobile `/pro` LCP rising from 656 ms to 838 ms. The median was flat (344 → 360 ms), and the daily synthetic test showed no regression. Only the tail moved.
- Desktop `/pro` had a p75 LCP of 1,420 ms against a p75 FCP of 572 ms over 2026-09-16 to 10-16.
- The tail rows named `#root h1.text-6xl` as the LCP element. Their `windowWidth` was mostly 800 or 1280: DebugBear's "mobile" includes tablets, foldables and desktop-site mode, which cross the `md:` breakpoint.
- Most other rows had `lcpSelector: null`. The LCP element there was the static paragraph, which React had detached before DebugBear read its selector.

## What Didn't Work

- **Reading the alert window's commits.** Nothing that renders `/pro` changed between 5 and 12 Oct. The alert itself was sampling noise, since weekly p75 swings between 632 and 1,088 ms on 60–125 views. It pointed at a structural cost that predates the window.
- **Throttled lab tests on phone widths.** At 360–412 px the static `<p>` (about 44k px²) stays the largest element, so the lab never showed the late entry. Only a probe at 800 px and above reproduced it.
- **Full SSR plus hydration**, the welcome page's pattern, was rejected. It would delete the curated crawler block, moving its pricing table and FAQ into App across 26 locales, and it needs hydration-safe URL attribution.

## Solution

Render the real first viewport into the static HTML at build time, above the curated copy:

- `ProHomeShell` (`pro-test/src/App.tsx:1408`) renders the nav, `<main>` and hero. `App` and the prerender share it, so the markup exists once.
- `pro-test/src/pro-first-viewport-prerender.tsx` renders it with `renderToStaticMarkup`. `spliceProFirstViewport` (`pro-test/prerender.mjs:343`) puts the curated `<section id="pro-overview">` inside the shell's `<main>`, after the hero.
- The curated `<h1>` text becomes a visually hidden lead in the hero `<h1>` (`App.tsx:477`), so the page keeps one `<h1>` and one `<main>`.
- The hero's motion wrapper uses `initial={false}` (`App.tsx:468`). With an `initial` state of `opacity: 0`, the static hero would ship invisible, and Chrome does not count an opacity-0 paint as LCP.
- `/pro`-only critical CSS (`PRO_CRITICAL_CSS`, `prerender.mjs:141`) mirrors the hero and nav geometry. It goes into `index.html` only (`PAGE_CRITICAL_CSS`, `prerender.mjs:161`), so `welcome.html` is unchanged.

The client still mounts with `createRoot`, with no hydration. React's hero is the same size as the static one, so its paint is not a larger candidate and emits no new LCP entry.

Local result on the built bytes (stylesheet +400 ms, JS +1,500 ms, 4x CPU): 2,364 → 80 ms at 800 px, 1,776 → 84 ms at 1280 px, CLS 0.

## Why This Works

LCP records a new entry only when a newly painted element is larger than the current largest. When `createRoot` swaps a small static block for a larger React tree, the larger element's first paint becomes the LCP, at bundle-mount time. A paint of the same size or smaller does not. Painting the final hero in the HTML makes the first paint the largest one.

Two CSS facts decided the mirrors' shape:

- The shared critical CSS is unlayered, so it outranks every Tailwind layer, even after the sheet loads. Its `main h1` and `main>section:first-child` rules (`prerender.mjs:101`) were already overriding the `/pro` hero in production: the h1 computes to 36/48/72 px, not the source's `text-6xl`/`md:text-8xl`. The static hero inherits the same rules, so its first-paint size already matches React's.
- New mirrors sit in `@layer utilities`, under Tailwind's own class selectors. Unlayered mirrors such as `.mt-4` or `.bg-wm-green` would have beaten Tailwind's `md:` and `hover:` variants on the live page. Layered mirrors set geometry before the sheet lands, and Tailwind's later rules take over afterwards.

## Prevention

- `e2e/pro-hero-lcp.spec.ts` holds the entry JS for 1.5 s and asserts three things at 360/800/1280: the static hero paints visibly, no LCP entry lands at or after the React mount, and the final candidate is the hero `<h1>`. It fails on the old code with `LCP entries after the React mount ... size=65024 H1 "Noise→Signal"`. CI runs it as `npm run test:e2e:pro-lcp`.
- `e2e/pro-critical-css-cls.spec.ts` checks `/pro` at 1280 as well as 360. A missing mirror for a prerendered class shows up there as a layout shift.
- When a DebugBear LCP alert fires, split the page views by `lcpSelector`, `windowWidth` and `lcpText` before reading commits. A null selector means the element was detached. A flat median means only the tail moved.
- Remaining gap: the static hero is English. A localized heading wider than "Noise→Signal", such as "Rauschen→Signal", still emits a late entry. Per-locale static HTML would close it.
- Any edit to `pro-test/src/App.tsx` needs the full `npm run test:data`. `tests/pro-signal-bars-compositor.test.mjs` regex-matches component source and broke when the `Hero` signature changed.

## Related Issues

- PR #9175 contains the fix.
- #9174 tracks a separate bug found during verification: mounted mobile `/pro` lays out 807 px wide because `ApiSection`'s grid items lack `min-w-0`.
- `docs/solutions/runtime-errors/vite-drops-entry-stylesheet-link-when-css-lives-in-a-shared-chunk.md` covers the deferred stylesheet path that the `/pro` critical CSS exists to cover.
