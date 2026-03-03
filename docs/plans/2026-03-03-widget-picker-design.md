# Widget Picker & Layout Presets Design

**Issue:** #882 — Replace drag-and-drop panel layout with a "+" button to add/remove info boxes
**Date:** 2026-03-03
**Model:** Robinhood Legend widget picker UX

---

## Overview

Replace the Settings > Panels toggle workflow with a first-class "+" widget picker popover in the header toolbar, add "x" close buttons to each panel, and introduce layout preset tabs for quick switching between curated panel configurations.

## Components

### 1. Layout Tabs (Header)

Layout preset tabs in the header bar, between left controls (logo/variant/region) and right controls (search/settings).

**Default layouts (Full variant):**
- **Intelligence Analyst** — cii, strategic-risk, intel, gdelt-intel, cascade, live-news, monitors, satellite-fires, displacement
- **Market Watch** — markets, commodities, crypto, economic, macro-signals, etf-flows, stablecoins, gulf-economies, heatmap
- **Breaking News** — live-news, politics, us, europe, middleeast, africa, latam, asia, live-webcams
- **Minimal** — map, live-news, insights, strategic-posture

Each variant (tech, finance, happy) gets its own set of curated presets.

**Behavior:**
- Styled as small pill buttons (11px uppercase, `var(--text-dim)`, active gets `var(--accent)` highlight)
- Clicking a tab swaps the visible panel set immediately
- Active layout persisted to localStorage
- Modified layouts show a dot/asterisk indicator; re-clicking the tab resets to defaults

### 2. "+" Widget Picker Popover

A "+" button in `.header-right` (next to search, theme toggle, fullscreen). Opens a dropdown popover anchored below.

**Popover structure:**
- Header row with "Add Widget" title and search/filter input
- Categorized list using existing `PANEL_CATEGORY_MAP`, filtered by current variant
- Each item shows panel name with toggle indicator (checkmark if visible, empty if hidden)
- Click to toggle — adds panel (appended to grid end) or removes it
- Max-height ~400px with scroll, width ~280px

**Styling:**
- Follows existing dropdown pattern: `position: absolute; top: 100%; right: 0;`, `z-index: 1000`, `border-radius: 6px`, `box-shadow`
- Category headers as small dim uppercase labels
- Items styled like `.export-option` — 8px 12px padding, hover highlight
- Click outside or Escape to close

### 3. Panel "x" Close Button

Each panel gets an "x" button in its `.panel-header`, right side, after existing badges.

- ~16x16px, transparent background, `var(--text-dim)`, hover brightens
- Click immediately hides panel (no confirmation)
- Grid auto-reflows via CSS `auto-fill`
- Map panel excluded — always visible

### 4. Settings > Panels Tab Removal

Remove the Panels tab from UnifiedSettings. The "+" popover and "x" buttons replace it entirely. Settings modal keeps General, Sources, and Status tabs.

## Interaction Model

**Layout tab click:**
1. Check for saved overrides in `worldmonitor-layout-overrides-{name}`
2. If overrides exist, apply those; otherwise apply preset defaults
3. Write result to `worldmonitor-panels`
4. Call `applyPanelSettings()` to show/hide panels
5. Persist active layout name to `worldmonitor-active-layout`

**Widget toggle (via "+" popover or "x" button):**
1. Toggle panel in `panelSettings`
2. Save to `worldmonitor-panels`
3. Diff against active layout preset — if different, save overrides and mark tab as modified
4. Call `applyPanelSettings()`

**Reset modified layout:**
- Click the already-active (modified) layout tab to reset to preset defaults
- Clears `worldmonitor-layout-overrides-{name}`

## Persistence

| Key | Type | Purpose |
|-----|------|---------|
| `worldmonitor-active-layout` | string | Currently selected layout name |
| `worldmonitor-layout-overrides-{name}` | object | Per-layout panel enabled/disabled overrides |
| `worldmonitor-panels` | object | Source of truth for current panel visibility (existing) |
| `worldmonitor-panel-order` | array | Panel drag order (existing, unchanged) |
| `worldmonitor-panel-spans` | object | Panel resize heights (existing, unchanged) |
| `worldmonitor-panel-col-spans` | object | Panel resize widths (existing, unchanged) |

## New Files

- `src/config/layouts.ts` — exports `LAYOUT_PRESETS` mapping layout names to panel key arrays, variant-aware

## Kept Unchanged

- Drag-and-drop for panel reorder within the grid (positioning, not visibility)
- Panel resize handles (row + column)
- Panel base class structure
- Variant system (layouts are variant-aware but independent of variants)

## Future Considerations

- Custom user-created layouts (requires accounts/auth)
- Layout sharing via URL
- Per-layout panel order persistence
