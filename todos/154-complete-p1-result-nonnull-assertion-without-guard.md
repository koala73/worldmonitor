---
status: complete
priority: p1
issue_id: "154"
tags: [code-review, quality, supply-chain, type-safety]
dependencies: [153]
---

# Non-Null Assertion on Optional `result` Without Guard in Polling Loop

## Problem Statement
In `SupplyChainPanel.ts:679`, `result = status.result!` uses a non-null assertion on a field typed as optional. If the server sends `{ status: 'done' }` without `result` (version mismatch or worker bug), `undefined` is silently passed to `onScenarioActivate`, which crashes in `activateScenario` when it calls `result.topImpactCountries.map(...)`. Additionally, `impactPct * 100` in `showScenarioSummary` could produce `NaN` if the upstream type changes (prior art: `feedback_pizzint_spike_magnitude_type.md`).

## Findings
- **File:** `src/components/SupplyChainPanel.ts`, line 679
- **Code:** `if (status.status === 'done') { result = status.result!; break; }`
- `status.result` is typed as optional (`result?: ScenarioResult`)
- If `status.result` is absent, `undefined` propagates to `activateScenario` → crash in `topImpactCountries.map(...)`
- `impactPct` is numeric but upstream could change to string (see MEMORY: `feedback_pizzint_spike_magnitude_type.md`)

## Proposed Solutions

### Option A: Explicit guard + type narrowing (Recommended)
```ts
if (status.status === 'done') {
  const r = status.result;
  if (!r || !Array.isArray(r.topImpactCountries)) throw new Error('done without valid result');
  result = r;
  break;
}
```
**Pros:** Explicit, catches server bugs, type-safe without `!`
**Cons:** Slight verbosity
**Effort:** Small | **Risk:** None

### Option B: Minimal guard only
```ts
if (status.status === 'done') {
  if (!status.result) throw new Error('done without result');
  result = status.result;
  break;
}
```
Protects against `undefined` but not malformed `topImpactCountries`.
**Effort:** Small | **Risk:** Low

## Recommended Action
_Apply Option A — adds one guard line, eliminates the `!` assertion._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts`
- **Lines:** 679

## Acceptance Criteria
- [ ] Non-null assertion `!` removed from `status.result`
- [ ] `topImpactCountries` presence verified before use
- [ ] `npm run typecheck` passes without `!` assertion

## Work Log
- 2026-04-10: Identified by kieran-typescript-reviewer during PR #2910 review

## Resources
- PR: #2910
- MEMORY: `feedback_pizzint_spike_magnitude_type.md`
