---
status: pending
priority: p1
issue_id: "035"
tags: [code-review, security, auth, clerk, jwt]
dependencies: []
---

## Problem Statement

`jwtVerify()` in `server/auth-session.ts` has no `algorithms` allowlist. `jose` defaults to accepting whatever algorithm the token header declares. An attacker could present a token using `alg: none` or an unexpected signing algorithm to bypass signature verification.

## Findings

- **File:** `server/auth-session.ts:43-46`
- `jwtVerify(token, jwks, { issuer, audience })` — no `algorithms` field
- Clerk issues RS256 tokens. This should be enforced explicitly.
- Without `algorithms: ['RS256']`, a token declaring `alg: HS256` or `alg: none` could be accepted by some `jose` versions or future updates.
- One-line fix.

## Proposed Solutions

**Option A: Add `algorithms: ['RS256']` (Recommended)**
```ts
const { payload } = await jwtVerify(token, jwks, {
  issuer: CLERK_JWT_ISSUER_DOMAIN,
  audience: 'convex',
  algorithms: ['RS256'],
});
```

- **Pros:** Correct. Enforces Clerk's actual signing algorithm. Cheap to verify.
- **Cons:** None.
- **Effort:** Small (1 line)
- **Risk:** None

**Option B: Add both RS256 and ES256 to handle future Clerk key rotation**

- **Pros:** Forward-compatible if Clerk switches algorithms.
- **Cons:** Slightly wider allowlist.
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] `jwtVerify` call includes explicit `algorithms` allowlist
- [ ] Test: token with `alg: HS256` or unexpected algorithm is rejected
- [ ] Existing auth-session tests continue to pass

## Work Log

- 2026-03-26: Identified during PR #1812 security audit (security-sentinel agent). File: `server/auth-session.ts:43`.
