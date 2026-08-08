---
status: complete
priority: p3
issue_id: "030"
tags: [code-review, quality, finance-panels]
dependencies: []
---

# MacroTilesPanel: Fragile Delta Formatter Switching on tile.id

## Problem Statement

`MacroTilesPanel.ts:59-61` uses a single expression that switches formatter behavior by `tile.id` string comparison and strips characters from formatted output. Breaks silently if a tile id or format function changes.

## Findings

```typescript
const deltaStr = delta !== null
  ? `${delta >= 0 ? '+' : ''}${tile.id === 'cpi' ? delta.toFixed(2) : tile.format(delta).replace('$', '').replace('B', '')}${tile.id === 'cpi' ? '' : tile.id === 'gdp' ? 'B' : ''} vs prior`
  : '';
```

- Switches on `tile.id` string comparison
- Strips `$` and `B` from formatted output then re-appends `B` for GDP
- Adding a new tile with a different format will silently produce wrong output
- The `MacroTile` interface already has a `format` field — a `deltaFormat?: (v: number) => string` field would be the correct extension point

## Proposed Solutions

### Option A: Add deltaFormat field to MacroTile interface

Add `deltaFormat?: (v: number) => string` to `MacroTile`, define it per-tile in the tiles array. Clean, self-contained, extensible.

- **Effort**: Small
- **Risk**: Low

### Option B: Keep as-is with a comment

Add an explanatory comment documenting the intent. Low effort but keeps fragility.

- **Effort**: Minimal
- **Risk**: Low

## Acceptance Criteria

- [ ] Adding a new tile type to MacroTilesPanel does not require updating a switch expression
- [ ] Delta formatting logic is co-located with tile definition

## Work Log

- 2026-03-26: Identified by code review of PR #2258
