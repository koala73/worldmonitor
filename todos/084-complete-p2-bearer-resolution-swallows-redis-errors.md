---
status: complete
priority: p2
issue_id: "084"
tags: [code-review, oauth, mcp, reliability]
dependencies: []
---

# `resolveApiKeyFromBearer` returns null on Redis errors, causing misleading 401 on infra failure

## Problem Statement

`resolveApiKeyFromBearer` in `api/_oauth-token.js` treats any `readJsonFromUpstash` failure (timeout, connection error, Redis unavailable) the same as "token not found." This causes OAuth-authenticated MCP clients to receive HTTP 401 during a Redis outage, forcing them to re-authenticate — which also fails because `/oauth/token` also uses Redis. The 401 is a lie: the token may be valid but Redis is simply down.

## Findings

- `api/_oauth-token.js:9` — `const apiKey = await readJsonFromUpstash('oauth:token:${token}');`
- `api/_upstash-json.js` — returns `null` on any fetch failure, timeout, or parse error (does not throw)
- `api/mcp.ts:436-439` — when `resolveApiKeyFromBearer` returns null and a Bearer header is present, returns HTTP 401 with `error="invalid_token"`
- TypeScript reviewer: "A transient Redis outage thus locks out all OAuth-authenticated clients with no indication that the failure was infrastructure, not the token."
- A 401 on token-not-found and 401 on Redis-down are indistinguishable to the caller
- The correct behavior for Redis unavailability is HTTP 503 or a clear error in the 500 range, not 401

## Proposed Solutions

### Option 1: Distinguish error types via thrown exception

Modify `resolveApiKeyFromBearer` to re-throw on infrastructure errors (non-404 failures):

```javascript
export async function resolveApiKeyFromBearer(req) {
  const hdr = req.headers.get('Authorization') || '';
  if (!hdr.startsWith('Bearer ')) return null;
  const token = hdr.slice(7).trim();
  if (!token) return null;
  // Throws on network/timeout error (infrastructure failure)
  // Returns null if key is missing from Redis (valid "not found")
  const apiKey = await readJsonFromUpstash(`oauth:token:${token}`);
  return typeof apiKey === 'string' && apiKey ? apiKey : null;
}
```

This requires `readJsonFromUpstash` to distinguish "key not found" (returns null) from "fetch error" (throws). If `_upstash-json.js` doesn't distinguish these, it would need updating.

**Pros:** Correct semantics. Infrastructure errors become 500 in `mcp.ts`'s existing catch block.
**Cons:** Requires changes to `_upstash-json.js` to propagate error vs. null distinctly.
**Effort:** Medium
**Risk:** Low

---

### Option 2: Discriminated return type

Change `resolveApiKeyFromBearer` to return a discriminated union:

```typescript
type BearerResult =
  | { status: 'no_bearer' }
  | { status: 'valid'; apiKey: string }
  | { status: 'invalid' }  // token not in Redis
  | { status: 'error' };   // infrastructure failure
```

On `status: 'error'`, `mcp.ts` returns HTTP 503 instead of 401.

**Pros:** Explicit types, correct HTTP semantics per failure mode.
**Cons:** More complex refactor; changes `_oauth-token.js` and `mcp.ts`.
**Effort:** Medium
**Risk:** Low (but larger change)

---

### Option 3: Accept the current behavior (document only)

Add a comment explaining that Redis failure causes transient 401s for OAuth clients, and that clients should implement re-auth with backoff. Document in the PR description.

**Pros:** No code change.
**Cons:** Misleading error semantics. OAuth clients will loop re-authenticating against a system that's down.
**Effort:** 0
**Risk:** Medium (latent reliability issue)

## Recommended Action

Option 2 is the cleanest long-term. Short-term, Option 1 is acceptable. The key change needed is: infrastructure errors should not map to 401.

## Technical Details

**Affected files:**
- `api/_oauth-token.js` — return discriminated result or throw on infrastructure error
- `api/mcp.ts:432-439` — handle `resolveApiKeyFromBearer` error case distinctly
- Possibly `api/_upstash-json.js` — expose "key not found" vs "fetch error" distinction

## Acceptance Criteria

- [ ] Redis timeout/connection error does not return HTTP 401 to caller
- [ ] "Token not in Redis" (expired) still returns HTTP 401 with `error="invalid_token"`
- [ ] Infrastructure failure returns HTTP 503 or 500
- [ ] Existing OAuth happy-path tests pass

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- TypeScript reviewer flagged as HIGH severity
- Traced through: `readJsonFromUpstash` → null on any failure → `resolveApiKeyFromBearer` returns null → mcp.ts returns 401
- Redis down = misleading "invalid token" to caller, triggers re-auth loop that also fails
