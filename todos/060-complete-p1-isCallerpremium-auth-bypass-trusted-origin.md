---
status: complete
priority: p1
issue_id: "060"
tags: [code-review, security, authentication, analytical-frameworks]
dependencies: []
---

# `isCallerPremium` grants premium to ALL trusted browser origins — free users bypass PRO gate

## Problem Statement
`server/_shared/premium-check.ts` calls `validateApiKey(request, {})` first. `validateApiKey` returns `{ valid: true, required: false }` for ANY request from a trusted origin (worldmonitor.app, Vercel preview URLs, localhost) — regardless of the user's subscription tier. Since `isCallerPremium` short-circuits to `true` on `keyCheck.valid`, every free-tier user on the web app passes the PRO gate for `framework`/`systemAppend`. The Bearer token / Clerk JWT path that actually checks `session.role === 'pro'` is never reached for browser sessions.

The `validateApiKey` function was designed for origin-level access control ("is this a legitimate caller of our API?"), NOT for tier entitlement ("is this caller a paying PRO subscriber?"). Conflating these two meanings makes the entire `framework`/`systemAppend` PRO feature ungated in production.

## Findings
- **`server/_shared/premium-check.ts:10-12`** — `if (keyCheck.valid) return true;` triggers for all worldmonitor.app sessions
- **`api/_api-key.js:49-68`** — `isTrustedBrowserOrigin()` returns `true` for `*.worldmonitor.app`, `*vercel.app`, `localhost`; causes `validateApiKey` to return `{ valid: true, required: false }` with no key present
- **`src/services/panel-gating.ts:15`** — client-side `hasPremiumAccess()` correctly checks role; server-side `isCallerPremium` diverges from this contract
- Confirmed independently by: kieran-typescript-reviewer, security-sentinel, architecture-strategist

## Proposed Solutions

### Option A: Remove validateApiKey short-circuit for web users (Recommended)
Only count `validateApiKey` as premium if `required: true` (meaning an explicit API key was validated, not just trusted origin):
```ts
export async function isCallerPremium(request: Request): Promise<boolean> {
  const keyCheck = validateApiKey(request, {}) as { valid: boolean; required: boolean };
  if (keyCheck.valid && keyCheck.required) return true; // explicit API key callers (desktop)

  // Browser sessions: must resolve via Bearer token
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    return session.valid && session.role === 'pro';
  }
  return false;
}
```
**Pros:** Minimal change, correct semantics | **Effort:** Small | **Risk:** Low

### Option B: Remove validateApiKey entirely, rely solely on Bearer token
Only check Bearer token for premium. API key holders who lack a Bearer token would not get premium. This is simplest but may break desktop callers without JWT.
**Pros:** Simplest | **Cons:** Desktop callers may lose access if they don't include Bearer | **Effort:** Small | **Risk:** Medium

## Technical Details
- File: `server/_shared/premium-check.ts`
- PR: koala73/worldmonitor#2386
- Related: `api/_api-key.js:49-68` (`isTrustedBrowserOrigin`)

## Acceptance Criteria
- [ ] Free-tier users on worldmonitor.app do NOT pass `isCallerPremium` check
- [ ] PRO users with valid Bearer token DO pass `isCallerPremium`
- [ ] Desktop callers with explicit API key DO pass `isCallerPremium`
- [ ] Test: stub `validateApiKey` returning `{ valid: true, required: false }` → `isCallerPremium` returns `false`

## Work Log
- 2026-03-28: Identified during PR #2386 review by 3 independent agents
