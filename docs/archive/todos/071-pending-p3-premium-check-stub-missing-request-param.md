---
status: pending
priority: p3
issue_id: "071"
tags: [code-review, testing, analytical-frameworks]
dependencies: []
---

# `premium-check-stub.ts` drops `request: Request` parameter from real function signature

## Problem Statement
`tests/helpers/premium-check-stub.ts`:
```ts
export async function isCallerPremium(): Promise<boolean> { return false; }
```
The real `isCallerPremium` signature is `(request: Request): Promise<boolean>`. The stub drops the parameter, making TypeScript unable to catch future call sites that forget to pass `request`.

Also: the stub only returns `false` — there is no `true` variant, so tests cannot cover the premium code path in handlers that use `isCallerPremium`.

## Proposed Solution
```ts
export async function isCallerPremium(_request: Request): Promise<boolean> {
  return false;
}

export async function isCallerPremiumTrue(_request: Request): Promise<boolean> {
  return true;
}
```

## Technical Details
- File: `tests/helpers/premium-check-stub.ts`
- Effort: Trivial | Risk: Low

## Acceptance Criteria
- [ ] Stub signature matches real function: `(request: Request): Promise<boolean>`
- [ ] Both `false` and `true` variants available for test authors

## Work Log
- 2026-03-28: Identified by kieran-typescript-reviewer and architecture-strategist during PR #2386 review
