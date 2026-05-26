---
status: pending
priority: p3
issue_id: "165"
tags: [code-review, security, supply-chain, rate-limiting]
dependencies: []
---

# Scenario Rate Limiter Keys Off IP — Shared Egress Customers Share Rate Bucket

## Problem Statement
`api/scenario/v1/run.ts` rate-limits requests by client IP. In enterprise or office environments where many users share a single egress IP (NAT, VPN), all users share one rate bucket. A single heavy user can exhaust the quota for all colleagues on the same IP. The correct key for a PRO-gated endpoint is the authenticated API key identity.

## Findings
- **File:** `api/scenario/v1/run.ts`
- Rate limit key: likely `getClientIp(req)` (standard pattern in codebase)
- PRO endpoints in the codebase that handle multiple users per IP should key by API key identity
- See MEMORY: `feedback_is_caller_premium_trusted_origin.md` — the API key is extractable from `X-WorldMonitor-Key`
- Minor issue: scenario endpoint is PRO-only, low traffic volume — not urgent
- Identified by security-sentinel during PR #2910 review

## Proposed Solutions

### Option A: Key rate limit by API key when present, fall back to IP
```ts
const apiKey = req.headers.get('x-worldmonitor-key');
const rateLimitKey = apiKey ? `scenario:key:${apiKey}` : `scenario:ip:${getClientIp(req)}`;
```
**Pros:** Per-identity limiting for authenticated users, IP fallback for unauth
**Cons:** Unauthenticated requests still IP-keyed (acceptable)
**Effort:** Small | **Risk:** None

## Recommended Action
_Apply Option A in a follow-up. Not blocking — scenario endpoint is PRO-only and low-traffic._

## Technical Details
- **Affected files:** `api/scenario/v1/run.ts`

## Acceptance Criteria
- [ ] Rate limit key uses `X-WorldMonitor-Key` when present
- [ ] Falls back to IP for requests without a key
- [ ] Existing rate limit tests pass

## Work Log
- 2026-04-10: Identified by security-sentinel during PR #2910 review

## Resources
- PR: #2910
- MEMORY: `feedback_is_caller_premium_trusted_origin.md`
