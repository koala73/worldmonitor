---
status: complete
priority: p1
issue_id: "077"
tags: [code-review, security, oauth, rfc-compliance]
dependencies: []
---

# Token response missing Cache-Control: no-store (RFC 6749 §5.1)

## Problem Statement

RFC 6749 §5.1 explicitly requires: "The authorization server MUST include the HTTP `Cache-Control` response header field with a value of `no-store` in any response containing tokens, credentials, or other sensitive information." The token endpoint in `api/oauth/token.js` omits this header. A CDN, proxy, or browser cache could store a token response and serve it to a different requester.

## Findings

- `api/oauth/token.js:5-10` — `jsonResp` helper adds only `Content-Type` and CORS headers
- No `Cache-Control: no-store` or `Pragma: no-cache` on the success response (line 116)
- `vercel.json` has no explicit cache rule for `/oauth/(.*)` responses
- Security agent: H-2 — "Required by RFC 6749. CF or Vercel CDN could cache a 200 token response"
- This is a one-line fix with zero risk

## Proposed Solutions

### Option 1: Add headers to success response only

**Approach:** Add `'Cache-Control': 'no-store', 'Pragma': 'no-cache'` to the `jsonResp()` call at line 116 (success path only). Error responses are fine without it.

```js
return jsonResp({
  access_token: uuid,
  token_type: 'Bearer',
  expires_in: TOKEN_TTL_SECONDS,
  scope: 'mcp',
}, 200, {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
});
```

**Effort:** 5 minutes

**Risk:** None

## Recommended Action

Option 1 — add the two headers to the success `jsonResp` call. One-line fix.

## Technical Details

**Affected files:**

- `api/oauth/token.js:116-121`

## Resources

- **PR:** #2418
- **RFC:** RFC 6749 §5.1 — Successful Response
- **Security finding:** H-2 (security-sentinel)

## Acceptance Criteria

- [ ] `POST /oauth/token` success response includes `cache-control: no-store`
- [ ] `POST /oauth/token` success response includes `pragma: no-cache`
- [ ] Error responses (400, 401, 405, 500) are unaffected

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel flagged RFC 6749 §5.1 non-compliance
- Confirmed absence of `Cache-Control: no-store` in token response
- Confirmed one-line fix
