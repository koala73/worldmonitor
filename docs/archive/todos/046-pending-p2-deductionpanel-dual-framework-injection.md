---
status: pending
priority: p2
issue_id: "046"
tags: [code-review, quality, analytical-frameworks]
dependencies: []
---

# `DeductionPanel.ts` — dual framework injection path causes double-apply

## Problem Statement
`DeductionPanel.handleSubmit()` appends the active framework's `systemPromptAppend` to `geoContext` (line ~126), but then also sends `framework: ''` in the `deductSituation` RPC call. This means the framework text is injected via `geoContext` (which gets appended to the system prompt server-side) AND the `framework` field is an empty string (which does nothing). The intent was to pass `framework` as the dedicated field, not to fold it into `geoContext`. The current code does neither correctly: `framework: ''` means the server-side `systemAppend` path is never used, while the geoContext append works but bypasses the server-side `frameworkHash` cache key logic.

## Findings
- **`src/components/DeductionPanel.ts:123-126`** — `geoContext = \`${geoContext}\n\n---\nAnalytical Framework:\n${fw.systemPromptAppend}\``
- **`src/components/DeductionPanel.ts:135`** — `deductSituation({ query, geoContext, framework: '' })` — framework field is empty
- The server reads `req.framework` for the `systemAppend` path; `geoContext` is a separate field
- Flagged by: kieran-typescript-reviewer, agent-native-reviewer

## Proposed Solutions

### Option A: Use the `framework` field (aligned with server implementation)
Pass the framework text via the dedicated `framework` field and remove the manual `geoContext` append:
```ts
const fw = getActiveFrameworkForPanel('deduction');
// Remove the geoContext manual append for frameworks
const resp = await client.deductSituation({
  query,
  geoContext,
  framework: fw?.systemPromptAppend ?? '',
});
```
**Pros:** Uses the dedicated field, enables cache key hashing | **Effort:** Small | **Risk:** Low

### Option B: Keep geoContext append, remove framework field workaround
If the server-side `framework` path is not yet ready, explicitly comment that the geoContext append is intentional and `framework: ''` is a placeholder:
```ts
framework: '', // TODO #041: pass fw?.systemPromptAppend here once cache key is fixed
```
**Pros:** Clear intent | **Cons:** Framework is injected via geoContext, bypassing server-side cache key logic | **Effort:** Trivial | **Risk:** Low

## Technical Details
- File: `src/components/DeductionPanel.ts`
- PR: koala73/worldmonitor#2380
- Note: Fix todo #041 (deduct-situation cache key) alongside this fix

## Acceptance Criteria
- [ ] Framework is passed via exactly one path (either `geoContext` append OR `framework` field — not both)
- [ ] The chosen path is consistent with how `get-country-intel-brief.ts` handles frameworks

## Work Log
- 2026-03-27: Identified during PR #2380 review by kieran-typescript-reviewer
