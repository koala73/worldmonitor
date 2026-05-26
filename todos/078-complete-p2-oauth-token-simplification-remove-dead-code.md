---
status: complete
priority: p2
issue_id: "078"
tags: [code-review, quality, oauth, simplification]
dependencies: []
---

# OAuth token files: remove dead code and simplify (parseBasicAuth, JSON body, clientId/issuedAt)

## Problem Statement

`api/oauth/token.js` and `api/_oauth-token.js` contain ~60% dead or over-engineered code relative to their actual use case (claude.ai `client_credentials` with form-encoded body). The code-simplicity reviewer identified three YAGNI violations that add maintenance surface without any real-world value.

## Findings

- `api/oauth/token.js:43-54` — `parseBasicAuth` (12 lines) is never used by any known client. Claude.ai uses `client_secret_post` form encoding only.
- `api/oauth/token.js:56-76` — `parseBody` JSON branch (20 lines). No OAuth 2.0 client sends `application/json` to a token endpoint (spec uses form-encoded). Zero real-world callers.
- `api/oauth/token.js:33` — `clientId` and `issuedAt` stored in Redis but never read back by `_oauth-token.js`. Pure dead payload in Redis.
- `api/_oauth-token.js:6-26` — 28 lines duplicating `_upstash-json.js` Redis boilerplate. Can be replaced with:

```js
import { readJsonFromUpstash } from './_upstash-json.js';
// ...
const entry = await readJsonFromUpstash(`oauth:token:${token}`);
return entry?.apiKey ?? null;
```

- Discovery doc advertises only `client_secret_post` and `client_secret_basic` — but `client_secret_basic` is only supported by the dead `parseBasicAuth` code path
- Simplicity reviewer: estimated ~57 LOC reduction (80 → 23 across both files)

## Proposed Solutions

### Option 1: Remove all dead code in one pass

**Approach:**

1. Delete `parseBasicAuth` function and the Basic-auth branch in `handler`
2. Replace `parseBody` with 3 inline lines: `const params = new URLSearchParams(await req.text()); const grantType = params.get('grant_type'); const clientSecret = params.get('client_secret');`
3. Remove `clientId` and `issuedAt` from `storeToken` — store only the `apiKey` string as the Redis value (eliminates `JSON.stringify`/`JSON.parse` round-trip)
4. Rewrite `_oauth-token.js` to delegate to `readJsonFromUpstash`:
   ```js
   import { readJsonFromUpstash } from './_upstash-json.js';
   export async function resolveApiKeyFromBearer(req) {
     const hdr = req.headers.get('Authorization') || '';
     if (!hdr.startsWith('Bearer ')) return null;
     const token = hdr.slice(7).trim();
     if (!token) return null;
     const apiKey = await readJsonFromUpstash(`oauth:token:${token}`);
     return typeof apiKey === 'string' && apiKey ? apiKey : null;
   }
   ```
5. Update discovery doc to remove `client_secret_basic` from `token_endpoint_auth_methods_supported` since Basic auth is no longer supported

**Pros:**
- ~57 LOC reduction
- `_oauth-token.js` now reuses existing tested code instead of duplicating Redis boilerplate
- Redis stores `apiKey` as plain string (faster GET, no JSON parse)
- Stored value validates: `typeof apiKey === 'string' && apiKey` guards against corrupted entries

**Cons:**
- Removes `client_secret_basic` support — fine since no client uses it
- Need to verify `readJsonFromUpstash` can return a plain string (not just an object)

**Effort:** 2-3 hours

**Risk:** Low (removing unused code paths)

---

### Option 2: Keep Basic auth, only simplify storage

**Approach:** Keep `parseBasicAuth` and JSON body branch, but simplify Redis storage (plain string) and rewrite `_oauth-token.js` to use `readJsonFromUpstash`.

**Pros:** More spec coverage

**Cons:** Keeps ~35 lines of dead code

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Option 1. The dead code provides no value and creates maintenance burden. The simplification of `_oauth-token.js` is particularly important — it currently duplicates the Redis boilerplate that `_upstash-json.js` already handles, including the `encodeURIComponent` question (which goes away since `readJsonFromUpstash` handles it).

## Technical Details

**Affected files:**

- `api/oauth/token.js` — remove parseBasicAuth, simplify parseBody, simplify storage
- `api/_oauth-token.js` — rewrite to delegate to `readJsonFromUpstash`
- `api/_upstash-json.js` — verify it handles plain string values (currently used for JSON objects)
- `public/.well-known/oauth-authorization-server` — remove `client_secret_basic` from auth methods if Basic is removed

## Resources

- **PR:** #2418
- **Simplicity finding:** code-simplicity-reviewer (high confidence)
- **TS finding:** item #5 (encodeURIComponent on Redis key fixed by using readJsonFromUpstash)

## Acceptance Criteria

- [ ] `api/_oauth-token.js` delegates to `readJsonFromUpstash` (no duplicate Redis boilerplate)
- [ ] `resolveApiKeyFromBearer` validates returned value is a non-empty string before returning
- [ ] Redis stores `apiKey` as plain string (verify with `redis-cli GET oauth:token:<uuid>`)
- [ ] Token issuance and Bearer resolution end-to-end still work
- [ ] Tests pass

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Code-simplicity-reviewer identified 3 YAGNI violations and estimated 57 LOC reduction
- TS reviewer independently noted `encodeURIComponent` risk (fixed by this simplification)
- Architecture reviewer noted clientId/issuedAt are dead payload
