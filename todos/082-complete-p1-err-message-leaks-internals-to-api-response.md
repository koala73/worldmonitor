---
status: complete
priority: p1
issue_id: "082"
tags: [code-review, security, mcp, information-disclosure]
dependencies: []
---

# `err.message` leaks internal service details in MCP tool error responses

## Problem Statement

PR #2418 changed the MCP catch block from a hardcoded string to `err.message`, creating an information disclosure regression. Error messages from internal services can contain Redis key names, Upstash endpoint hostnames, internal service URLs, IP addresses, and stack fragments. The original code deliberately masked this with a static string.

## Findings

- `api/mcp.ts:520-521` — changed from:
  ```typescript
  } catch {
    return rpcError(id, -32603, 'Internal error: data fetch failed');
  ```
  to:
  ```typescript
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(id, -32603, `Internal error: ${msg}`);
  ```
- Security sentinel: "The `err.message` from a network call, Redis read, or JSON parse failure can contain internal URLs, Redis key names, Upstash endpoint hostnames, internal service names, or stack fragments."
- Example leak: `Internal error: fetch failed — connect ECONNREFUSED 10.0.0.5:443` maps internal network topology
- The original masking was intentional; this change is an unintentional regression introduced while adding the `catch (err)` for type narrowing
- TypeScript reviewer flagged as regression: "This is a regression: the original code deliberately masked the error."

## Proposed Solutions

### Option 1: Log to Sentry, return fixed string (recommended)

```typescript
} catch (err) {
  // Log full error internally for debugging, mask from API callers
  console.error('[mcp] tool execution error:', err);
  return rpcError(id, -32603, 'Internal error: data fetch failed');
}
```

If Sentry is wired in: `Sentry.captureException(err)` before returning.

**Pros:** Retains debuggability, masks internals from API surface.
**Cons:** Requires Sentry integration or console.error.
**Effort:** Small (1 line change)
**Risk:** Low

---

### Option 2: Sanitize error message before returning

Strip known patterns (URLs, IPs, file paths) from `err.message` before including in response.

**Pros:** Gives some signal without full masking.
**Cons:** Regex sanitization is hard to get right and easy to bypass. Sanitization creates a false sense of security.
**Effort:** Medium
**Risk:** Medium (sanitization gaps can still leak)

---

### Option 3: Revert to hardcoded string, keep err for logging only

```typescript
} catch (err: unknown) {
  console.error('[mcp] executeTool error:', err);
  return rpcError(id, -32603, 'Internal error: data fetch failed');
}
```

**Pros:** Exact revert to the intentional behavior.
**Effort:** Small
**Risk:** Low

## Recommended Action

Option 3. The catch block only needs `err` for logging, not for the response string. Revert response to hardcoded string, keep `catch (err: unknown)` for console/Sentry.

## Technical Details

**Affected files:**
- `api/mcp.ts:516-520` — change 2 lines

## Acceptance Criteria

- [ ] Tool error responses do not expose `err.message` to callers
- [ ] Error is logged (console.error or Sentry)
- [ ] Response string matches or is equivalent to original "Internal error: data fetch failed"
- [ ] TypeScript type error from `catch (err)` is handled without leaking message

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Security sentinel (H-3) and TypeScript reviewer both flagged independently
- Root cause: developer changed `catch` to `catch (err)` for type narrowing and accidentally introduced the leak by adding `err.message` to the response
- Original hardcoded string was intentional masking, not a lazy placeholder
