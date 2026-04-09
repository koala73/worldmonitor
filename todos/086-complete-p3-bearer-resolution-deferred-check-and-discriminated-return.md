---
status: complete
priority: p3
issue_id: "086"
tags: [code-review, quality, oauth, mcp]
dependencies: [084]
---

# Defer Bearer resolution in `mcp.ts` + discriminated return type for `resolveApiKeyFromBearer`

## Problem Statement

Two related simplification opportunities in `api/mcp.ts` auth chain:

1. `resolveApiKeyFromBearer(req)` is called unconditionally before the Bearer header is checked, creating an invisible `await` for non-Bearer requests (though no I/O fires due to the short-circuit in `_oauth-token.js`). Future maintainers may not know there's zero cost for non-Bearer callers.

2. `resolveApiKeyFromBearer` returns `string | null` where null means EITHER "no Bearer header" OR "Bearer present but token not found." `mcp.ts` handles the "Bearer present" case by re-reading `req.headers.get('Authorization')` — the header is parsed twice.

## Findings

- `api/mcp.ts:431-435` — `bearerHeader` is read to gate the 401 path, but `resolveApiKeyFromBearer` also reads Authorization internally
- Performance oracle: "The `await` on a synchronously-resolved `null` return is a microtask tick, not a real I/O pause — but the pattern prevents future readers from understanding the cost model."
- Simplicity reviewer: "The correct fix is a discriminated return type that makes the call contract explicit and testable."
- Double header read: `req.headers.get('Authorization')` called at line 431 and again at line 5 of `_oauth-token.js`

## Proposed Solutions

### Option 1: Deferred conditional resolution

```typescript
let apiKey = '';
const authHeader = req.headers.get('Authorization') ?? '';
if (authHeader.startsWith('Bearer ')) {
  const bearerApiKey = await resolveApiKeyFromBearer(req);
  if (bearerApiKey) {
    apiKey = bearerApiKey;
  } else {
    return new Response(...401...);
  }
} else {
  // Direct key path — zero Upstash I/O
  const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
  ...
}
```

Eliminates unconditional await and the double header read. `resolveApiKeyFromBearer` can accept the pre-read `token` string instead of `req`.

**Pros:** Self-documenting cost model. Single header read.
**Cons:** Slightly longer code but clearer.
**Effort:** Small

---

### Option 2: Discriminated return from `resolveApiKeyFromBearer`

```typescript
type BearerResult = { found: true; apiKey: string } | { found: false; hadBearer: boolean };

export async function resolveApiKeyFromBearer(req): Promise<BearerResult> {
  const hdr = req.headers.get('Authorization') || '';
  if (!hdr.startsWith('Bearer ')) return { found: false, hadBearer: false };
  const token = hdr.slice(7).trim();
  if (!token) return { found: false, hadBearer: true };
  const apiKey = await readJsonFromUpstash(`oauth:token:${token}`);
  if (typeof apiKey === 'string' && apiKey) return { found: true, apiKey };
  return { found: false, hadBearer: true };
}
```

`mcp.ts` then needs no second header read and no `bearerHeader` variable.

**Pros:** Explicit contract, eliminates double-read, testable.
**Cons:** Changes `_oauth-token.js` signature (only called from one place today).
**Effort:** Small-Medium

## Recommended Action

Option 1 is the quickest win. Option 2 is cleaner if todo #084 is also implemented (since the discriminated return would add the `error` case there too).

## Technical Details

**Affected files:**
- `api/mcp.ts:430-445` — restructure auth chain
- `api/_oauth-token.js` — optionally change signature per Option 2

## Acceptance Criteria

- [ ] `Authorization` header is not read twice for the same request
- [ ] Unconditional `await resolveApiKeyFromBearer` is replaced with conditional logic
- [ ] All existing auth paths still work
- [ ] No test regressions

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Performance oracle and simplicity reviewer both flagged
- Confirmed: double header read at mcp.ts:431 and _oauth-token.js:5
- No runtime performance issue (short-circuit returns synchronously) but code clarity suffers
