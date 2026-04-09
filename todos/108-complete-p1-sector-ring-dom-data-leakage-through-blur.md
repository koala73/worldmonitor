---
status: pending
priority: p1
issue_id: "108"
tags: [code-review, security, pro-gate, dom, data-leakage]
---

# Blurred sector ring passes real sector data through renderSectorRing — DOM readable despite CSS blur

## Problem Statement
`src/components/MapPopup.ts` — when `!isPro`, the locked-state render path calls `renderSectorRing(sectors)` with real `CHOKEPOINT_HS2_SECTORS` data (actual share percentages and labels). The SVG is then blurred via `filter:blur(4px)`. CSS blur is a visual effect only; the SVG `stroke` colors derived from real data, the legend text (`Energy 78%`, `Chemicals 9%`, etc.), and all percentage values are fully readable in the DOM via DevTools. A free user can inspect the sector breakdown by reading the HTML source.

## Findings
`MapPopup.ts` lines 1215-1220 — `renderSectorRing(sectors)` called with full real data for the blurred lockout div. The actual sector shares and labels (e.g. `Energy 78%`) are present verbatim in the rendered SVG DOM, accessible to any user who opens browser DevTools.

## Proposed Solutions

### Option A: Replace real data with placeholder data in non-pro path (Recommended)
- For the non-pro path, pass zeroed/placeholder data to `renderSectorRing` (e.g. all shares = 20, all labels = '?')
- The blur overlay still conveys the existence of a chart without leaking the actual distribution
- Effort: Small | Risk: Low

### Option B: Omit renderSectorRing entirely in non-pro path
- Render only the lock icon overlay without calling `renderSectorRing` at all
- Simpler but loses the visual affordance that a chart exists behind the paywall
- Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] DOM inspection of the non-pro waterway popup shows no real sector share percentages
- [ ] DOM inspection shows no real sector label names (e.g. "Energy", "Chemicals") with real values
- [ ] Pro users continue to see the full real sector ring with correct data
- [ ] Visual blur effect is preserved for non-pro users

## Resources
- PR: #2870
