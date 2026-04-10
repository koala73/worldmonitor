---
status: complete
priority: p2
issue_id: "160"
tags: [code-review, security, supply-chain, auth]
dependencies: []
---

# Scenario Fetch Calls in `attachScenarioTriggers` Missing Auth Header

## Problem Statement
The `fetch` calls in `SupplyChainPanel.attachScenarioTriggers()` — both the initial `POST /api/scenario/v1/run` and the polling `GET /api/scenario/v1/status` — send no authentication header. The API endpoints use `validateApiKey()` which, for browser origins (trusted), silently returns `required: false` and skips key validation. This means PRO-gated endpoints are reachable unauthenticated from any browser tab that happens to have the right origin header.

## Findings
- **File:** `src/components/SupplyChainPanel.ts` — `attachScenarioTriggers()` polling loop
- No `X-WorldMonitor-Key` or `Authorization` header on either fetch call
- `validateApiKey(req)` with no `{ forceKey: true }` returns `{ required: false }` for browser origins (see MEMORY: `feedback_validateapikey_forcekey_vendor.md`)
- The PRO gate is only checked client-side in `MapContainer.activateScenario()` — bypassing it server-side is trivial via curl with `Origin: https://worldmonitor.app`
- Identified by security-sentinel during PR #2910 review

## Proposed Solutions

### Option A: Add auth header using `getApiKey()` (Recommended)
```ts
import { getApiKey } from '@/services/auth-state';

// In attachScenarioTriggers():
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
const apiKey = getApiKey();
if (apiKey) headers['X-WorldMonitor-Key'] = apiKey;

const runResp = await fetch('/api/scenario/v1/run', { method: 'POST', headers, body: JSON.stringify(payload) });
// ...
const statusResp = await fetch(`/api/scenario/v1/status?jobId=...`, { headers });
```
**Pros:** Consistent with other authenticated panel fetches, enables server-side PRO gating
**Cons:** None
**Effort:** Small | **Risk:** None

### Option B: Add `forceKey: true` on the API endpoints + client auth header
Also update the API endpoints to use `validateApiKey(req, { forceKey: true })` to reject unauthenticated browser requests.
**Pros:** Defense in depth — server-side gate enforced regardless of client behavior
**Cons:** Requires API changes too
**Effort:** Small | **Risk:** Low

## Recommended Action
_Apply Option A immediately (client auth header). Option B should follow as a separate API hardening change._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts`
- `api/scenario/v1/run.ts` and `api/scenario/v1/status.ts` — consider `forceKey: true` follow-up

## Acceptance Criteria
- [ ] Both fetch calls in `attachScenarioTriggers` include `X-WorldMonitor-Key` header when available
- [ ] No regression for users without an API key (header omitted gracefully)
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by security-sentinel during PR #2910 review

## Resources
- PR: #2910
- MEMORY: `feedback_validateapikey_forcekey_vendor.md`
- MEMORY: `feedback_is_caller_premium_trusted_origin.md`
