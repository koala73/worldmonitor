---
status: complete
priority: p1
issue_id: "075"
tags: [code-review, security, performance, oauth, mcp]
dependencies: []
---

# Add rate limiting to /oauth/token endpoint

## Problem Statement

`api/oauth/token.js` has no rate limiting. An attacker can call this endpoint at full Vercel Edge concurrency to brute-force `client_secret` values from `WORLDMONITOR_VALID_KEYS`. The MCP endpoint has per-key rate limiting but the token issuance endpoint — the highest-value attack surface — has zero backpressure.

## Findings

- `api/oauth/token.js` — no calls to any rate limiter (line 1-122, entire file)
- `api/mcp.ts:437-457` — has `@upstash/ratelimit` with 60/min per key; same pattern needed here
- `api/_rate-limit.js` — existing IP-based rate limiter (600 req/60s) already in the codebase
- `validateSecret` runs a linear `Array.includes` scan on every request with no per-IP backpressure
- Security agent: "An attacker can call this endpoint at full Vercel Edge concurrency globally"
- Performance agent: "At 10x request volume the token endpoint is the first bottleneck"
- Architecture agent: "Credential stuffing vector — C2 blocking"

## Proposed Solutions

### Option 1: IP-based rate limit via `_rate-limit.js`

**Approach:** Import and call `checkRateLimit(req)` from `api/_rate-limit.js` at the top of the handler, before `parseBody`. Uses Upstash Redis, same as all other endpoints.

**Pros:**
- One import, two lines of code
- Consistent with existing pattern
- Handles Cloudflare `CF-Connecting-IP` header correctly (already in `_rate-limit.js`)

**Cons:**
- Generic 600/60s limit — may be too permissive for a credential endpoint

**Effort:** 30 minutes

**Risk:** Low

---

### Option 2: Tighter custom limiter (10/min per IP)

**Approach:** Instantiate a new `Ratelimit` instance in `oauth/token.js` with a tighter window (10 req/min per IP), keyed on `CF-Connecting-IP` or `X-Real-IP`. Pattern mirrors `getMcpRatelimit()` in `mcp.ts`.

**Pros:**
- Appropriate tightness for a credential endpoint
- Independent from the general API rate limiter

**Cons:**
- ~15 additional lines of code
- One more Redis key namespace (`rl:oauth-token:`)

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Use **Option 2**. 10 requests/min per IP is the right limit for a token endpoint. The MCP rate limiter pattern in `mcp.ts` is the exact template. Add before the `parseBody` call.

## Technical Details

**Affected files:**

- `api/oauth/token.js` — add rate limiter instance + check in handler
- `api/_rate-limit.js` — reference for IP extraction pattern

**Related components:**

- `api/mcp.ts:437-457` — rate limiter pattern to mirror

## Resources

- **PR:** #2418
- **Security finding:** C-2 (security-sentinel agent)
- **Performance finding:** CRITICAL (performance-oracle agent)
- **Architecture finding:** C2 (architecture-strategist agent)

## Acceptance Criteria

- [ ] Rate limiter is called before `validateSecret` in the token handler
- [ ] IP extraction uses `CF-Connecting-IP` → `X-Real-IP` fallback (per existing pattern)
- [ ] Returns `{ error: "rate_limit_exceeded" }` with HTTP 429 on limit breach
- [ ] Token issuance still works on first request with valid credentials
- [ ] Tests pass (node --test tests/deploy-config.test.mjs)

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security-sentinel, performance-oracle, and architecture-strategist all independently flagged this as blocking
- Confirmed no rate limiter exists in `api/oauth/token.js`
- Identified `getMcpRatelimit()` in `api/mcp.ts` as the exact pattern to follow
