---
status: complete
priority: p2
issue_id: "026"
tags: [code-review, typescript, simulation-runner, maintainability]
---

# Redis key strings duplicated between TS handler and MJS seed script

## Problem Statement

`SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest'` is defined independently in both `server/worldmonitor/forecast/v1/get-simulation-outcome.ts` and `scripts/seed-forecasts.mjs`. The same duplication exists for `SIMULATION_PACKAGE_LATEST_KEY`. `server/_shared/cache-keys.ts` (referenced in the worldmonitor-bootstrap-registration pattern) exists for exactly this purpose: shared Redis key constants that TypeScript handlers and seed scripts need to agree on. A future rename in one file without the other produces a silent miss where the handler reads an empty key forever.

## Findings

**F-1:**
```typescript
// server/worldmonitor/forecast/v1/get-simulation-outcome.ts line 10
const SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest';

// scripts/seed-forecasts.mjs line 35
const SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest';
// Two independent definitions with no enforcement of consistency
```

**F-2:** Same pattern for `SIMULATION_PACKAGE_LATEST_KEY` between `get-simulation-package.ts` and `seed-forecasts.mjs`.

## Proposed Solutions

### Option A: Move keys to `server/_shared/cache-keys.ts`, import in handler (Recommended)

```typescript
// server/_shared/cache-keys.ts — add:
export const SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest';
export const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';

// server/worldmonitor/forecast/v1/get-simulation-outcome.ts — replace local const:
import { SIMULATION_OUTCOME_LATEST_KEY } from '../../../_shared/cache-keys';
```

The seed script (`scripts/seed-forecasts.mjs`) keeps its own definition since it's a standalone MJS module that cannot import from TypeScript source. But the TypeScript handler becomes the downstream consumer of a canonical definition, making renames TypeScript-checked.

Effort: Small | Risk: Low

### Option B: Add a comment cross-referencing both locations

Not a fix, but documents the relationship so a human renaming one knows to update the other. Use as a stopgap if Option A causes import complexity.

## Acceptance Criteria

- [ ] `SIMULATION_OUTCOME_LATEST_KEY` exported from `server/_shared/cache-keys.ts`
- [ ] `get-simulation-outcome.ts` imports from `cache-keys.ts` instead of local const
- [ ] `SIMULATION_PACKAGE_LATEST_KEY` moved simultaneously
- [ ] `get-simulation-package.ts` updated to import from `cache-keys.ts`
- [ ] TypeScript compilation clean after change

## Technical Details

- Files: `server/worldmonitor/forecast/v1/get-simulation-outcome.ts:10`, `server/worldmonitor/forecast/v1/get-simulation-package.ts:~10`, `server/_shared/cache-keys.ts`
- Scripts keep their own definitions (they're standalone MJS — can't import from TS source)

## Work Log

- 2026-03-24: Found by compound-engineering:review:kieran-typescript-reviewer in PR #2220 review
