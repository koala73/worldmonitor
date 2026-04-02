---
status: complete
priority: p3
issue_id: "031"
tags: [code-review, performance, finance-panels]
dependencies: []
---

# FSIPanel: Missing getHydratedData Fast Path

## Problem Statement

`FSIPanel.fetchData()` always fires a live `getFearGreedIndex` RPC call, even though `getHydratedData('fearGreedIndex')` already contains the FSI fields from bootstrap. This causes a redundant Redis round-trip on every panel open.

## Findings

The `fearGreedIndex` bootstrap key contains `hdr.fsi.value`, `hdr.fsi.label`, `hdr.vix.value`, `hdr.hySpread.value` — all the fields FSIPanel needs. The `_collectRegimeContext()` method in `data-loader.ts` already demonstrates the correct pattern: check `getHydratedData('fearGreedIndex')` first, fall back to RPC if absent.

FSIPanel skips this optimization entirely. On sessions with a bootstrap payload, every FSI panel open costs an extra RPC call to Redis.

## Proposed Solutions

### Option A: Mirror _collectRegimeContext pattern

Check `getHydratedData('fearGreedIndex')` at the top of `fetchData()`. Extract FSI fields from `hdr.fsi`. Fall back to RPC only if hydrated data is absent or `unavailable`.

```typescript
const hydrated = getHydratedData('fearGreedIndex') as Record<string, unknown> | undefined;
if (hydrated && !hydrated.unavailable) {
  // extract hdr.fsi fields and render
  return true;
}
// fall back to RPC
```

- **Effort**: Small
- **Risk**: Low — hydrated data read is synchronous and always stale by definition

## Acceptance Criteria

- [ ] FSIPanel reads from bootstrap hydration on sessions where fearGreedIndex is loaded
- [ ] Falls back to RPC when hydrated data is absent
- [ ] No visible change in rendered output

## Work Log

- 2026-03-26: Identified by performance review of PR #2258
