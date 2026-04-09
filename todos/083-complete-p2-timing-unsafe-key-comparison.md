---
status: complete
priority: p2
issue_id: "083"
tags: [code-review, security, oauth, timing-attack]
dependencies: []
---

# Non-constant-time API key comparison enables timing oracle attack

## Problem Statement

Both `api/oauth/token.js` (`validateSecret`) and `api/mcp.ts` (direct key path) use `Array.includes()` for API key validation. JavaScript `===` exits on the first mismatching byte, creating a timing side-channel. Over enough requests, an attacker can enumerate valid key prefixes character by character. The OAuth token endpoint is the most exposed surface since it validates the full raw API key with no caching.

## Findings

- `api/oauth/token.js:47` — `return validKeys.includes(secret);`
- `api/mcp.ts:449` — `if (!validKeys.includes(candidateKey))`
- Security sentinel: "JavaScript's `===` operator exits on the first mismatching byte. For a known partial key prefix, an attacker can run thousands of requests and measure response time differentials to enumerate valid key prefixes character by character."
- Rate limit (10 req/min per IP) slows but does not prevent: Vercel edge runs globally, a distributed attacker sources from many IPs
- Fix is `crypto.timingSafeEqual` on Uint8Array-encoded key bytes (available in Web Crypto API on edge runtimes)

## Proposed Solutions

### Option 1: `crypto.timingSafeEqual` on Uint8Array (recommended)

```javascript
function timingSafeIncludes(candidateKey, validKeys) {
  if (!candidateKey) return false;
  const enc = new TextEncoder();
  const candidate = enc.encode(candidateKey);
  return validKeys.some(k => {
    const valid = enc.encode(k);
    if (valid.length !== candidate.length) return false;
    return crypto.subtle.timingSafeEqual(valid, candidate);
  });
}
```

Note: `crypto.subtle.timingSafeEqual` is available in the Web Crypto API (edge runtimes). Node's `crypto.timingSafeEqual` is not available in Vercel edge.

**Pros:** Eliminates timing oracle. Cryptographically sound.
**Cons:** Requires encoding keys to Uint8Array before comparison. Slightly more code.
**Effort:** Small (1 helper function, 2 call sites)
**Risk:** Low

---

### Option 2: Use Web Crypto HMAC comparison

Compute `HMAC-SHA256(key, nonce)` and compare digests. More complex, similar result.

**Pros:** Industry standard for constant-time comparison.
**Cons:** More complex than `timingSafeEqual`, requires a nonce.
**Effort:** Medium
**Risk:** Low (but overkill vs Option 1)

---

### Option 3: Accept risk (defer)

The rate limiter and short key length (typical API keys are random high-entropy strings) reduce practical attack feasibility significantly. Accept the risk and document it.

**Pros:** No code change.
**Cons:** Leaves a known timing oracle on a credential endpoint.
**Effort:** 0
**Risk:** Medium (latent)

## Recommended Action

Option 1. `crypto.subtle.timingSafeEqual` is available on Vercel edge runtime. The fix is a single helper function replacing two `Array.includes` calls.

## Technical Details

**Affected files:**
- `api/oauth/token.js:45-49` — replace `validateSecret`
- `api/mcp.ts:448-450` — replace inline `validKeys.includes`
- Potentially extract to `api/_api-key.js` as `isValidApiKey(k)` (see todo #085)

## Acceptance Criteria

- [ ] No `Array.includes` used for API key comparison in `token.js` or `mcp.ts`
- [ ] Constant-time comparison used for all key validation
- [ ] Edge runtime compatibility verified (no Node.js `crypto` module)
- [ ] Existing tests still pass

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel flagged as H-2 (HIGH)
- Both key validation call sites identified
- `crypto.subtle.timingSafeEqual` confirmed available on Web Crypto API (edge compatible)
