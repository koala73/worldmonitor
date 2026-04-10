---
status: complete
priority: p3
issue_id: "163"
tags: [code-review, quality, supply-chain, ux]
dependencies: []
---

# Scenario Banner Shows Raw Template ID Instead of Human-Readable Name

## Problem Statement
The scenario activation banner in `SupplyChainPanel.showScenarioSummary()` displays the raw `scenarioId` string (e.g., `"suez-full-closure-2026"`) rather than the template's `.name` property (e.g., `"Suez Canal Full Closure"`). Users see a machine identifier instead of a localized, readable label.

## Findings
- **File:** `src/components/SupplyChainPanel.ts`
- Banner HTML likely contains `${scenarioId}` where it should use `SCENARIO_TEMPLATES.find(tmpl => tmpl.id === scenarioId)?.name ?? scenarioId`
- `SCENARIO_TEMPLATES` is already imported in the same file
- Minor UX issue — doesn't block functionality
- Identified during code review of PR #2910

## Proposed Solutions

### Option A: Look up template name with fallback
```ts
const templateName = SCENARIO_TEMPLATES.find(tmpl => tmpl.id === scenarioId)?.name ?? scenarioId;
// Use templateName in banner heading
```
**Pros:** Shows human-readable label, graceful fallback to ID if template not found
**Effort:** Small | **Risk:** None

## Recommended Action
_Apply Option A — 1-line lookup._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts` — `showScenarioSummary()`

## Acceptance Criteria
- [ ] Banner heading shows template `.name`, not raw `scenarioId`
- [ ] Falls back to raw ID if template not found

## Work Log
- 2026-04-10: Identified during PR #2910 review

## Resources
- PR: #2910
