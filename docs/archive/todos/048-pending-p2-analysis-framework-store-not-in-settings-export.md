---
status: pending
priority: p2
issue_id: "048"
tags: [code-review, quality, analytical-frameworks, settings]
dependencies: []
---

# Custom frameworks not included in settings export/import — user data lost on reset

## Problem Statement
`analysis-framework-store.ts` uses its own localStorage keys (`wm-analysis-frameworks` for the library, `wm-panel-frameworks` for per-panel selections). The existing preferences/settings export/import flow does NOT include these keys. When a user exports their settings, migrates to a new device, or clicks "reset settings", all custom imported frameworks and their per-panel assignments are silently lost. This is particularly impactful since importing frameworks from agentskills.io URLs is a new user action.

## Findings
- **`src/services/analysis-framework-store.ts:6-7`** — `const LIBRARY_KEY = 'wm-analysis-frameworks'; const PANEL_KEY = 'wm-panel-frameworks';`
- **`src/services/preferences-content.ts`** — settings export/import handler does not include these two keys
- Flagged by: architecture-strategist

## Proposed Solutions

### Option A: Add framework keys to settings export/import (Recommended)
In `preferences-content.ts` (or wherever the settings export JSON is constructed), include `LIBRARY_KEY` and `PANEL_KEY` contents:
```ts
const exportData = {
  ...existingPreferences,
  'wm-analysis-frameworks': localStorage.getItem('wm-analysis-frameworks'),
  'wm-panel-frameworks': localStorage.getItem('wm-panel-frameworks'),
};
```
And on import, write them back.
**Pros:** Complete settings portability | **Effort:** Small | **Risk:** Low

### Option B: Expose export/import in the Analysis Frameworks section of settings
Add "Export frameworks" / "Import frameworks" buttons specifically in the Analysis Frameworks settings section, independent of the global settings export.
**Pros:** Granular control | **Cons:** Duplication of effort; user expects global export to be complete | **Effort:** Small | **Risk:** Low

## Technical Details
- Files: `src/services/analysis-framework-store.ts`, `src/services/preferences-content.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] Settings export JSON includes `wm-analysis-frameworks` and `wm-panel-frameworks`
- [ ] Settings import restores custom frameworks and per-panel assignments
- [ ] Built-in frameworks are not duplicated on import (they're already in the store constant)

## Work Log
- 2026-03-27: Identified during PR #2380 review by architecture-strategist
