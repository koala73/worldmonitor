---
status: complete
priority: p1
issue_id: "081"
tags: [code-review, security, oauth, mcp]
dependencies: []
---

# Remove `?key=` URL query param auth path — API key exposed in access logs

## Problem Statement

PR #2418 added `?key=` as a third auth fallback in `api/mcp.ts` for "clients that cannot set headers." This is a security regression: API keys in URL query parameters are logged verbatim by Vercel access logs, Cloudflare access logs, browser history, proxy logs, and Referer headers. Unlike HTTP headers, URL params cannot be stripped at the transport layer. The OAuth `client_credentials` flow this same PR introduces already solves the "no headers" use case, making `?key=` have no remaining justified use case.

## Findings

- `api/mcp.ts:442` — `const urlKey = new URL(req.url).searchParams.get('key') ?? '';` — new path added in this PR
- Security sentinel: "This is a new attack surface introduced specifically by this PR. The original `mcp.ts` used header-only auth."
- Architecture strategist: "The correct solution for clients that cannot set headers is the OAuth flow this PR already provides."
- Pre-PR auth used `validateApiKey(req, { forceKey: true })` which was header-only
- Any MCP request to `/mcp?key=wm_live_xxxxx` permanently records the API key in Vercel + CF logs
- Tool request URLs show up in browser devtools and Referer headers on redirect

## Proposed Solutions

### Option 1: Remove the `?key=` path (recommended)

Delete the `urlKey` line and its usage. Direct clients that cannot set custom headers to use the OAuth flow (`POST /oauth/token` → `Authorization: Bearer`).

```typescript
// Remove this:
const urlKey = new URL(req.url).searchParams.get('key') ?? '';
const headerKey = req.headers.get('X-WorldMonitor-Key') ?? '';
const candidateKey = urlKey || headerKey;

// Replace with:
const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
```

**Pros:** Eliminates credential-in-URL leakage. OAuth already handles the "no custom headers" use case.
**Cons:** Any existing client using `?key=` URL param breaks. (No known clients per PR description.)
**Effort:** Small (2 lines)
**Risk:** Low — no documented clients depend on `?key=` per PR description.

---

### Option 2: Keep `?key=` but gate behind env flag

Add `WORLDMONITOR_ALLOW_KEY_QUERY_PARAM=true` env var; only enable the `?key=` path if explicitly opted in.

**Pros:** Backward compat if any undocumented client uses it.
**Cons:** Still allows the security risk to exist in production; adds env config complexity.
**Effort:** Small
**Risk:** Low

---

### Option 3: Log a deprecation warning but keep the path

Return the response but add a header like `Warning: 299 - "API key in URL is deprecated; use Authorization: Bearer"`.

**Pros:** Non-breaking, signals deprecation.
**Cons:** Does not fix the log-exposure problem.
**Effort:** Small
**Risk:** Low (but doesn't fix the actual issue)

## Recommended Action

Option 1: Remove immediately. OAuth covers the stated use case. No documented clients depend on `?key=`.

## Technical Details

**Affected files:**
- `api/mcp.ts:440-451` — remove `urlKey` and change `const candidateKey = urlKey || headerKey` to `const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? ''`

## Acceptance Criteria

- [ ] `?key=` URL parameter is not present in `api/mcp.ts` auth chain
- [ ] `X-WorldMonitor-Key` header path still works
- [ ] OAuth Bearer path still works
- [ ] No test regressions

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel and architecture strategist independently flagged as P1 regression
- Pattern confirmed: OAuth `client_credentials` (added in same PR) covers the stated use case
- No known clients depend on `?key=` URL param per PR description
