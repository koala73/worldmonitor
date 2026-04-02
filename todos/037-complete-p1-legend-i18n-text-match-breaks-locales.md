---
status: complete
priority: p1
issue_id: "037"
tags: [code-review, bug, map, legend, i18n]
dependencies: ["036"]
---

# Legend visibility text-matching breaks on all non-English locales

## Problem Statement
`updateLegendVisibility()` matches legend item text content against hardcoded English strings
(`'Startup Hub'`, `'Tech HQ'`, `'HIGH'`, `'ELEVATED'`, `'MONITORING'`, etc.).
Legend items are built by `createLegend()` using `t('components.deckgl.legend.*')` (i18n).
On any non-English locale the translated text never matches the English strings — every legend
item is permanently hidden after the first layer toggle. Affects all 20 non-English locales.

## Findings

Example: German locale
- `t('components.deckgl.legend.startupHub')` → `'Startup-Zentrum'`
- `layerToLabels.startupHubs` → `['Startup Hub']`
- Match fails → item hidden forever

Additional mismatch even in English:
- `conflictZones: ['HIGH', 'ELEVATED', 'MONITORING']` — `en.json` values are `'High Alert'`, `'Elevated'`, `'Monitoring'` (mixed case, not all-caps). These never match.
- `cyberThreats: ['APT']` — no `'APT'` string in en.json legend keys.

## Proposed Solutions

### Option A: Use `t()` keys in the mapping
Replace hardcoded strings with `t('components.deckgl.legend.*')` calls in `layerToLabels`.

**Pros:** Simple change
**Cons:** Still couples `updateLegendVisibility()` to i18n key knowledge, brittle
**Effort:** Small | **Risk:** Low (but partial fix only)

### Option B: `data-legend-layer` attributes (eliminates the problem entirely)
See todo 036 Option B. No text matching at all — uses `MapLayers` key directly.

**Effort:** Small-Medium | **Risk:** Low

## Recommended Action
Option B (same as todo 036 — one fix addresses both issues).

## Technical Details
- File: `src/components/DeckGLMap.ts`
- 21 supported locales, only English partially works (and even then `HIGH`/`APT` don't match)
- PR: koala73/worldmonitor#2370

## Acceptance Criteria
- [ ] Legend visibility works correctly in French, German, Arabic, and other non-English locales
- [ ] No hardcoded English label strings in visibility logic

## Work Log
- 2026-03-27: Identified during PR #2370 review via security-sentinel + architecture-strategist agents
