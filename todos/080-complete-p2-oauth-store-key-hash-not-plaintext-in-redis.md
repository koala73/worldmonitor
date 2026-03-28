---
status: complete
priority: p2
issue_id: "080"
tags: [code-review, security, oauth, redis]
dependencies: [078]
---

# Store API key hash (not plaintext) in Redis OAuth token entries

## Problem Statement

`api/oauth/token.js` stores the raw `client_secret` (= the actual WorldMonitor API key) verbatim in Redis under `oauth:token:<uuid>`. Anyone who gains read access to Upstash (misconfigured token, support incident, future ACL issue) gets all live API keys in plaintext. Redis is now a second authoritative secret store alongside `WORLDMONITOR_VALID_KEYS`.

## Findings

- `api/oauth/token.js:33` — `value = JSON.stringify({ apiKey, ... })` stores raw API key
- `api/_oauth-token.js:24` — `return entry?.apiKey ?? null` returns the raw key directly
- `api/mcp.ts:431` — uses `bearerApiKey` directly for rate limiting and downstream calls
- Security agent C-1: "Anyone who dumps or scans Redis gets all live API keys in plaintext"
- After todo #078 simplification: Redis stores plain string `apiKey` — still plaintext

## Proposed Solutions

### Option 1: Store SHA-256 hash of key, re-validate on lookup

**Approach:**

On token issuance: `redis.set('oauth:token:<uuid>', sha256(apiKey))`

On Bearer resolution: `resolveApiKeyFromBearer` returns the hash. Then `mcp.ts` compares `sha256(candidate)` against stored value, and validates against `WORLDMONITOR_VALID_KEYS` using `Array.includes` (or constant-time comparison).

Actually — the simpler version: store `sha256(apiKey)` in Redis. On lookup, return the hash. In `mcp.ts`, compare `sha256(candidateKey)` against the hash for all valid keys in `WORLDMONITOR_VALID_KEYS`. If any match, the key is valid.

**Pros:**
- Redis compromise exposes hashes, not live API keys
- Defense-in-depth

**Cons:**
- Adds `crypto.subtle.digest` calls (available in Edge runtime)
- Slightly more complex lookup: hash comparison instead of direct string match
- Breaking change to stored token format (need migration or versioned format)

**Effort:** 2-3 hours

**Risk:** Medium (changing auth critical path)

---

### Option 2: Store a stable key ID (non-reversible label)

**Approach:** Generate a deterministic short ID from each key (e.g., first 8 chars of SHA-256 hex). Store only this as the token value. On lookup, compute the same ID for each candidate in `WORLDMONITOR_VALID_KEYS` and find the matching one.

**Pros:**
- Simpler than storing full hash
- Redis only exposes a partial fingerprint

**Cons:**
- Still requires iterating `WORLDMONITOR_VALID_KEYS` on every Bearer lookup

**Effort:** 2 hours

**Risk:** Medium

---

### Option 3: Accept the current design (defer)

**Approach:** Keep raw key storage but document the trust boundary. Rotate API keys immediately on any Upstash access incident.

**Pros:** No code change
**Cons:** Violates least-privilege principle; Redis breach = all active sessions compromised

**Effort:** 0

**Risk:** High (latent)

## Recommended Action

Implement Option 2 (key ID/fingerprint). The lookup path is simpler and Redis compromise exposes only partial fingerprints. Block on todo #078 (simplification) since that changes the storage format.

## Technical Details

**Affected files:**

- `api/oauth/token.js` — change stored value from raw key to key fingerprint
- `api/_oauth-token.js` — return fingerprint; update lookup logic in `mcp.ts`
- `api/mcp.ts` — match fingerprint against computed fingerprints of valid keys

## Resources

- **PR:** #2418
- **Security finding:** C-1 (security-sentinel agent)
- **Architecture note:** Architecture-strategist confirmed no-risk for current design but flagged Redis trust boundary

## Acceptance Criteria

- [ ] Redis `oauth:token:<uuid>` value does not contain raw API key
- [ ] Bearer token resolution still correctly identifies the originating API key
- [ ] Upstash dump of `oauth:token:*` keys reveals no plaintext API keys
- [ ] Full auth flow still works end-to-end

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel flagged as CRITICAL (C-1)
- Architecture strategist confirmed acceptable design for now but noted trust boundary gap
- Marked P2 (not P1) because: current API keys have short TTLs in practice, Upstash access is tightly controlled, and todo #078 must land first to establish the storage format
