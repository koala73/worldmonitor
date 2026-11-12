---
title: Theme-flipping color tokens make buttons unreadable in one theme
date: 2026-11-01
category: ui-bugs
module: src/styles
problem_type: ui_bug
component: tooling
symptoms:
  - "Upgrade to PRO button renders as a blank white block (route explorer, dark theme)"
  - "Green buttons show near-white text on green in the light theme (3.13:1)"
  - "Follow buttons lose their label on hover (about 1.05:1 in both themes)"
  - "Route explorer chips and active tab unreadable in light theme although the modal stays dark"
  - "Red, orange, amber and green status text 3.2-3.6:1 on white in the light theme"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [css, theme, contrast, wcag, css-variables, light-theme, route-explorer, upgrade-cta, semantic-colors, badges]
---

# Theme-flipping color tokens make buttons unreadable in one theme

## Problem

Several buttons, including every "Upgrade to PRO" call to action, were readable in one theme and unreadable in the other. Fixed in #9949 (route explorer CTA) and #9961 (sweep plus guard test).

## Symptoms

- Route explorer upgrade button: white text on a white `--accent` fill in dark.
- 15 green-fill buttons (Settings upgrade, country export, NEW tag, map toggles…): `color: var(--bg)` gives near-white on `#16a34a` in light, 3.13:1.
- Telegram/X follow buttons on hover: background `var(--accent-dim)`, a token that does not exist, so the declaration is dropped and the label vanishes.
- Route explorer chips 1.64:1 and active tab 1.0:1 in light.

An undefined token fails silently in a specific way: the declaration becomes invalid at computed-value time, so `color` falls back to the inherited text color, `background` to transparent, and a `border` shorthand to no border. A follow-up sweep found 23 such tokens across 62 uses on the dashboard; measured in the browser, the market chart modal had no background, the 2D map's active time-range button had no fill (its label vanished), and red/orange/green status colors rendered as plain text.

## What Didn't Work

- Adding a light-theme tint to the route explorer's active picker row. The modal is dark in both themes, so the row's inherited text is `#c9d1d9`; the light tint made it 1.15:1. Review caught it. Judge a rule against the surface it actually renders on, not the page theme.
- Per-rule light overrides (`[data-theme="light"] :is(...) { color: color-mix(var(--red) 70%, var(--text)) }`) for the status text one PR touched. They fixed 8 rules and left the other 338 that use the same tokens as text.
- Picking text shades against plain surfaces only. Tailwind -700 passed on white and `--bg-secondary` but failed on the translucent badge tints over them: `.findings-badge.critical`, `#b91c1c` on a 30% red tint over the `#e8e8e8` dropdown, came to 3.65:1. 93 tinted rules failed. Review caught it (#9988).
- A contrast guard that skipped every `color-mix()` background as "translucent". Opaque `color-mix(..., var(--surface))` tints then went unchecked. Only `transparent`, `rgba(` and `hsla(` are truly translucent.

## Solution

- Text on `--green` fills is a fixed `#0a0a0a` (as `.pro-banner-cta` already did): 15:1 dark, 6.0:1 light.
- Text on `--accent` fills is `var(--bg)`, which flips in step with `--accent`.
- Undefined tokens replaced with real ones (`var(--accent)`, `color-mix(in srgb, var(--accent) 12%, var(--surface))`).
- `.re-modal` in `src/styles/route-explorer.css` pins the dark values of every theme-dependent token the sheet reads (`--accent`, `--bg-secondary`, `--surface`, `--text-dim`, `--semantic-elevated`), so the always-dark modal looks the same in both themes.

- Semantic colors used as text (#9988): the light theme defines `--X-text` shades (Tailwind -800: red `#991b1b`, orange `#9a3412`, amber `#92400e`, green `#166534`), and every text rule reads `color: var(--X-text, var(--X))`. Fills, borders and map markers keep the bright `--X`. Dark leaves `--X-text` undefined so the fallback (and any scoped `--X` override) applies. Surfaces that stay dark in both themes (`.update-toast`, `.passkey-offer-prompt`, `.re-modal`) and the happy variant's light block set every `--X-text: initial`, which restores the fallback.

## Why This Works

`--accent` is `#fff` in dark and `#111111` in light; `--green` is `#44ff88` vs `#16a34a`. A text color must flip with its background or be dark enough for both fills. `--bg` flips opposite to `--accent`, so that pairing works. `--green` stays a mid-tone in both themes, and its light value `#16a34a` is too dark for the light theme's near-white `--bg`, so green fills need fixed dark text. A container whose own background never flips must not read flipping tokens, or its children change while it does not.

One token cannot serve both text and fill: a value bright enough to read as a marker on white is too faint as text on white. Splitting by use, with a fallback instead of a dark-theme definition, keeps dark mode byte-identical. A custom property set to `initial` is the guaranteed-invalid value, so `var(--X-text, var(--X))` falls back inside any container that resets it. Text on a tint must clear 4.5:1 against the composite (tint over the darkest surface it can sit on), which is why the shades are -800 rather than -700.

## Prevention

`tests/upgrade-cta-contrast.test.mjs` parses every `src/styles/*.css`, merges all `:root` and `[data-theme="light"]` blocks, resolves `var()` and `color-mix()` per theme, and requires 4.5:1 for:

- every upgrade CTA by selector;
- every rule whose solid background uses `var(--accent…)` or `var(--green…)` and that sets a text color, plus text-only `:hover` rules against their base background.

It fails on any undefined token without a fallback, and for each sheet listed in `SCOPED_TOKENS` it derives the tokens that differ between themes and requires the container to pin each one at its dark value. When adding a dark-only container, add it to `SCOPED_TOKENS`.

`tests/css-undefined-tokens.test.mjs` covers the other half: every `var(--x)` with no fallback, in every dashboard stylesheet, must name a token some dashboard sheet declares (following `base-layer.css`'s `@import` chain) or one the code sets inline. Standalone pages (plugin market, plugins, embed) ship their own palettes and are checked against their own sheets, so a token defined only on another page (the dashboard's `--muted` came from `plugin-market.css`) still fails. When it fails, map the token to an existing one; do not add a new token to make it pass.

`tests/light-semantic-text.test.mjs` fails on any text rule that reads a semantic token bare (`color: var(--red)`), any `--X-text` under 4.5:1 on `--bg`, `--surface` or `--bg-secondary`, any translucent text background (`rgba` or `color-mix(..., transparent)`) whose composite over `--surface`, `--bg-secondary` or `--border-subtle` is under 4.5:1 (a `[data-theme="light"] <selector>` background replaces the base one), and any always-dark surface or happy light block missing a reset. When adding an always-dark surface, add it to `ALWAYS_DARK` and the reset rule in `main.css`.

## Related Issues

- #9949, #9961, #9982 (undefined-token sweep), #9988 (light-theme semantic text)
