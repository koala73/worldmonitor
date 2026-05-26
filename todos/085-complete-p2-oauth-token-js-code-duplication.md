---
status: complete
priority: p2
issue_id: "085"
tags: [code-review, quality, oauth]
dependencies: []
---

# `api/oauth/token.js` duplicates 4 patterns already in existing helpers

## Problem Statement

`api/oauth/token.js` re-implements four utilities that already exist in the `api/` helper modules: `getClientIp`, key validation, `jsonResponse`, and CORS headers. This creates maintenance drift — if any of these patterns need to change (CF header priority, allowed CORS headers, key validation logic), `token.js` will not be updated.

## Findings

**1. `getClientIp` (token.js:36-43) duplicates `_rate-limit.js`**

`_rate-limit.js` has an identical function (same header priority: cf-connecting-ip → x-real-ip → x-forwarded-for → 0.0.0.0). If CF header priority changes again (it already changed once per MEMORY.md PR #1241), two files will diverge.

**2. `validateSecret` (token.js:45-49) duplicates key parsing from `_api-key.js` and `mcp.ts`**

`(process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean).includes(key)` now exists in 3 files. A fourth copy if direct-key path in `mcp.ts` also has it inline (line 448).

**3. `jsonResp` + `CORS_HEADERS` (token.js:7-18) duplicates `_json-response.js` + `_cors.js`**

`_json-response.js` exports `jsonResponse(body, status, headers)` with the same behavior. `_cors.js` exports `getPublicCorsHeaders()`. The local `CORS_HEADERS` hardcodes `Allow-Headers: Content-Type, Authorization` while the shared module includes `X-WorldMonitor-Key, X-Widget-Key, X-Pro-Key` too. This creates a silent CORS header divergence.

**4. `storeToken` raw pipeline fetch duplicates Upstash write pattern**

`_upstash-json.js` handles GET. There is no shared `writeJsonToUpstash`. `storeToken` owns the raw pipeline fetch including env-var guards, error handling, and `results[0]?.result === 'OK'` parsing. A second write path from another endpoint cannot reuse this.

## Proposed Solutions

### Option 1: Import from existing helpers (recommended)

```js
// Replace local getClientIp:
import { getClientIp } from '../_rate-limit.js';  // requires export on _rate-limit.js

// Replace validateSecret:
import { isValidApiKey } from '../_api-key.js';  // requires new named export

// Replace jsonResp + CORS_HEADERS:
import { getPublicCorsHeaders } from '../_cors.js';
import { jsonResponse } from '../_json-response.js';

// Keep storeToken as-is or extract writeJsonToUpstash to _upstash-json.js
```

**Pros:** Single source of truth for all patterns. ~25 LOC removed from token.js.
**Cons:** Requires small changes to 2 helper files (export `getClientIp`, add `isValidApiKey`).
**Effort:** Small-Medium
**Risk:** Low

---

### Option 2: Accept local copies, add doc comment explaining why

Add a comment: `// Note: local copy of _rate-limit.js:getClientIp to avoid import across api/oauth/ subdirectory.`

**Pros:** No helper changes needed.
**Cons:** Drift risk remains. Comment-based coupling is weaker than import-based coupling.
**Effort:** Tiny
**Risk:** Low (but doesn't fix the problem)

---

### Option 3: Extract all to `api/_oauth-utils.js`

Create a dedicated util file for OAuth-specific patterns.

**Pros:** Clean separation.
**Cons:** Overkill — the patterns already exist in shared helpers.
**Effort:** Small
**Risk:** Low

## Recommended Action

Option 1. The import path `../` works since `oauth/token.js` is in `api/oauth/`. Export `getClientIp` from `_rate-limit.js` and `isValidApiKey` from `_api-key.js`. Both are trivial changes.

## Technical Details

**Affected files:**
- `api/oauth/token.js` — remove 4 duplicated helpers, add imports
- `api/_rate-limit.js` — export `getClientIp`
- `api/_api-key.js` — export `isValidApiKey(k: string): boolean`
- Optionally: `api/_upstash-json.js` — add `writeJsonToUpstash(key, value, ttlSeconds)`

## Acceptance Criteria

- [ ] `getClientIp` used from one location
- [ ] Key validation logic used from one location
- [ ] CORS headers for token endpoint come from `_cors.js`
- [ ] `jsonResponse` from `_json-response.js`
- [ ] No duplicated patterns across `api/` helpers
- [ ] All existing tests pass

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Simplicity reviewer and architecture strategist both flagged
- getClientIp: exact copy confirmed by code comparison
- validateSecret pattern: appears in 3+ locations now
- CORS divergence: `token.js` misses `X-WorldMonitor-Key` from allow-headers vs `_cors.js`
