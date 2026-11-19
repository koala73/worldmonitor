---
title: "A translucent dashboard strip is unreadable in the light theme because the body stays near-black; give the strip an opaque themed base"
date: 2026-11-07
category: ui-bugs
module: src/styles/main.css
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "In the light theme the free-user Pro strip shows dark grey headline text on a near-black background"
  - "The strip looks correct in the dark theme, so dark-mode development never shows the problem"
  - "Headless Playwright screenshots (light colour scheme by default) show the strip as an unreadable dark bar"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - light-theme
  - cascade-layers
  - critical-css
  - contrast
  - pro-banner
---

# A translucent dashboard strip is unreadable in the light theme because the body stays near-black

## Problem

The free-user Pro strip (`.pro-banner`) was painted only with a translucent green gradient. In the light theme its headline text uses `--text` (dark grey), but the page behind the strip stayed near-black, so the headline was close to invisible. It shipped that way to every light-mode visitor, including phones set to light mode, and was found on 2026-11-06 while reworking the strip's mobile copy (PR #10249).

## Root cause

The first-paint critical CSS in `index.html` sets an unlayered rule:

```css
html,body{...background:#0a0a0a}
```

The themed rule `body { background: var(--bg) }` lives in `src/styles/main.css`, which `src/styles/base-layer.css` imports with `@import url('./main.css') layer(base);`.

Unlayered styles beat every cascade layer regardless of specificity or source order. So the layered `var(--bg)` never wins, and `body` keeps `#0a0a0a` in both themes. Most of the dashboard does not notice, because panels and the header paint their own opaque `--surface`/`--bg` backgrounds. Any top-level element painted only with a translucent tint shows that dark body through it, while its text colour follows the theme and turns dark.

`index.html` already documents the inverse case for `!important` overrides; this is the same layering rule applied to background colour.

## Solution

Give the strip an opaque themed base under its tint (#10249):

```css
.pro-banner {
  background: linear-gradient(...), var(--surface);
}
```

The gradient keeps its look in the dark theme, and in the light theme it now sits over a light surface, so the headline reaches normal contrast.

Changing the body background itself was left out of that PR: the rule is part of the first-paint critical CSS, so changing it affects every page load in both themes and needs its own check.

## Prevention

- Any new strip, toast or overlay at the dashboard top level needs an opaque themed base (`var(--surface)` or `var(--bg)`) under any translucent tint. Do not rely on the body colour.
- Assert it in e2e under both colour schemes. `e2e/pro-banner-mobile.spec.ts` checks that the strip's computed background has alpha 1 and that the headline has at least 4.5:1 contrast with `colorScheme: 'light'` and `'dark'`.
- Take at least one screenshot in the light scheme when reviewing dashboard UI. Playwright defaults to light, which is how this was caught.

## Related lessons from the same change

- The pre-paint script reserves 40px for the strip. A two-line mobile clamp fits: 2 × 13.75px line height + 10px padding + 1px border = 38.5px. At 6px padding it reached 40.5px and pushed the dashboard down.
- Check every locale at 360px with `/?lang=xx`, not only English. The English-only check missed overflowing Arabic, Portuguese, Swedish and Swahili headlines; review caught it, and the spec now loops over every locale file.

## Related

- `undefined-css-token-with-fallback-hides-light-theme-bugs` (auto memory [claude]): undefined tokens such as `--text-primary` with a dark fallback hide light-theme bugs the same way.
