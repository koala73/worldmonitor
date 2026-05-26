---
status: complete
priority: p2
issue_id: "079"
tags: [code-review, oauth, rfc-compliance, vercel]
dependencies: []
---

# Discovery doc: fix Content-Type header and remove wrong response_types_supported

## Problem Statement

Two issues with `public/.well-known/oauth-authorization-server`:

1. The file has no extension, so Vercel likely serves it as `application/octet-stream` or `text/plain`. RFC 8414 requires `Content-Type: application/json`.
2. `response_types_supported: ["token"]` is the wrong field — it refers to authorization endpoint response types (implicit flow), which doesn't exist here. For `client_credentials`-only servers, this field should be omitted or empty.

## Findings

- `public/.well-known/oauth-authorization-server` — no `.json` extension, no explicit Content-Type set in vercel.json
- Security agent M-3: "Vercel will likely serve as `application/octet-stream`. RFC 8414 requires `application/json`. Some MCP clients may reject it."
- Architecture agent M1: "`response_types_supported: ['token']` is implicit flow nomenclature. RFC 8414 §2 specifies this refers to authorization endpoint response types. Since there's no authorization endpoint, this field should be `[]` or omitted."
- The `vercel.json` `.well-known/(.*)` header rule adds CORS but not `Content-Type`

## Proposed Solutions

### Option 1: Add Content-Type header in vercel.json + fix response_types field

**Approach:**

1. Add `Content-Type: application/json` to the `/.well-known/oauth-authorization-server` header rule in `vercel.json` (or add a specific rule for just this file)
2. Remove `response_types_supported` from the discovery doc (or set to `[]`)

```json
{
  "source": "/.well-known/oauth-authorization-server",
  "headers": [
    { "key": "Content-Type", "value": "application/json" },
    { "key": "Access-Control-Allow-Origin", "value": "*" },
    { "key": "Cache-Control", "value": "public, max-age=3600" }
  ]
}
```

**Pros:**
- Fixes both issues in two files
- No rename needed (avoids rewrite rule complexity)
- Explicit rule is clearer than relying on file extension inference

**Effort:** 15 minutes

**Risk:** None

---

### Option 2: Rename file to .json + rewrite rule

**Approach:** Rename to `oauth-authorization-server.json`, add vercel.json rewrite from `/.well-known/oauth-authorization-server` to `/well-known/oauth-authorization-server.json`.

**Pros:** File extension carries semantic meaning

**Cons:** Adds a rewrite rule, slightly more complex

**Effort:** 20 minutes

**Risk:** Low

## Recommended Action

Option 1 — explicit `Content-Type` header in `vercel.json` is simpler and doesn't require a rewrite rule. Also remove `response_types_supported` from the discovery doc.

## Technical Details

**Affected files:**

- `vercel.json` — add specific header rule for `/.well-known/oauth-authorization-server`
- `public/.well-known/oauth-authorization-server` — remove `response_types_supported` field

## Resources

- **PR:** #2418
- **Security finding:** M-3 (security-sentinel)
- **Architecture finding:** M1 (architecture-strategist)
- **RFC 8414:** §2 — Authorization Server Metadata

## Acceptance Criteria

- [ ] `curl -I https://worldmonitor.app/.well-known/oauth-authorization-server` returns `content-type: application/json`
- [ ] Discovery doc no longer contains `response_types_supported` field (or it is `[]`)
- [ ] Discovery doc still contains all required fields: `issuer`, `token_endpoint`, `grant_types_supported`
- [ ] Tests pass (deploy-config tests)

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel flagged missing Content-Type (M-3)
- Architecture strategist flagged wrong response_types field (M1)
- Both are non-breaking fixes requiring minimal changes
