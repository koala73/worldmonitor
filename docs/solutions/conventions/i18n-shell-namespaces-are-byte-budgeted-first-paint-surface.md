---
title: "i18n shell namespaces are a byte-budgeted first-paint surface — post-boot copy must live outside them"
date: 2026-07-23
category: conventions
module: i18n
problem_type: convention
component: frontend
applies_when:
  - "Adding new t() keys referenced from eager chrome files (src/App.ts, src/app/panel-layout.ts, src/settings-main.ts, src/settings-window.ts, or anything under src/components/)"
  - "Choosing a namespace for UI copy that renders only after boot-time data resolves (auth, Convex snapshots, entitlements)"
tags: [i18n, en-shell, first-paint, byte-budget, locale-gates, premium-namespace, billing-state]
---

# i18n shell namespaces are a byte-budgeted first-paint surface — post-boot copy must live outside them

## Context

While adding billing-state CTA copy for panel gating (PR #5494, issue #4771), the natural home for the new keys looked like the existing `premium.*` namespace — the panel CTA already used `premium.signInToUnlock`, `premium.upgradeToPro`, etc. But `tests/i18n-english-shell.test.mjs` failed: it statically scans the eager chrome files (`src/App.ts`, `src/app/panel-layout.ts`, `src/settings-main.ts`, `src/settings-window.ts`, and everything under `src/components/`) for `t('...')` calls whose keys fall under `SHELL_KEY_PREFIXES` (a list that includes `premium.`, `shell.`, `header.`, `panels.`, `common.`, and others — see the constant near the top of the test), and requires every such key to exist **byte-identical** in `src/locales/en.shell.json`. And `en.shell.json` is capped by `SHELL_BUDGET_BYTES` (50 KB) — at the time of PR #5494 it sat 69 bytes under the cap, so adding even one new mirrored key meant either raising a first-paint performance budget or finding another home.

## Guidance

The shell (`en.shell.json`) exists so first-paint chrome renders English text before the full locale loads. Its namespaces are therefore a *scarce, perf-budgeted surface*, not a semantic taxonomy:

- **Copy that can only render after boot-time data resolves does not belong in a shell namespace.** Billing-state CTAs render after Clerk auth plus a Convex entitlement round-trip — by then the full locale file has long since loaded. PR #5494 put them under `components.billingState.*` (mirroring the existing non-shell `components.checkoutFailureBanner.*` precedent) instead of `premium.*`.
- **Check `SHELL_KEY_PREFIXES` in `tests/i18n-english-shell.test.mjs` before choosing a namespace** for any key referenced from an eager chrome file. A prefix hit means: mirrored entry in `en.shell.json` + budget pressure. `components.` is only shell-gated for the specific sub-prefixes listed there (`components.map.`, `components.panel.`, `components.proBanner.`, `components.settings.`, `components.deckgl.views.`); other `components.*` children are free.
- **Do not silently bump `SHELL_BUDGET_BYTES`.** The cap is a first-paint payload budget; raising it is a performance decision, not a namespace convenience.
- Remember the other two locale gates still apply wherever the key lives: the static key-existence scan (every literal `t('...')` key must exist in `en.json`) and locale completeness (every `en.json` key must exist in all ~25 locale files, `en.shell.json` exempt). Dynamic keys (`t(variable)`) bypass the static scan — when using them, add an explicit test asserting each possible key resolves in `en.json`, as `tests/billing-state-wiring.test.mts` does for the banner variant keys.

## Why This Matters

Choosing a shell namespace for post-boot copy either reds CI (budget exceeded) or, worse, quietly grows the first-paint payload every visitor downloads — paying real bytes for strings no one can see until seconds after boot. Choosing a non-shell namespace for genuinely first-paint copy is the opposite failure: raw i18n keys flash on screen before the full locale loads. The namespace decision is a rendering-time decision.

## When to Apply

Any new `t()` key referenced from an eager chrome file, and any copy addition to an existing shell namespace (`premium.`, `shell.`, `header.`, `panels.`, `common.`, and the rest of `SHELL_KEY_PREFIXES`). Ask one question: can this string render before the full locale file loads? If no, keep it out of shell namespaces.

## Examples

PR #5494's billing CTA keys, referenced from `src/components/Panel.ts` (an eager chrome file):

```ts
// Rejected: trips the shell mirror + 50KB budget (premium. is in SHELL_KEY_PREFIXES)
t('premium.billingRenewalPendingDesc')

// Shipped: components.billingState. is not shell-gated; these CTAs render
// post-entitlement-resolution, well after full-locale load
t('components.billingState.renewalPendingDesc')
```

## Related Issues

- PR #5494 (issue #4771) — where the constraint was hit and the `components.billingState.*` home was chosen.
- The three-gate interaction (static key existence, locale completeness, shell mirror + budget) makes a genuinely-new shell key a ~27-file change; a genuinely-new non-shell key is ~26 files (all full locales, no shell mirror).
