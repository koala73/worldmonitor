---
status: pending
priority: p3
issue_id: "164"
tags: [code-review, quality, supply-chain, reliability]
dependencies: []
---

# `fetchSectorDependency` Has No Circuit Breaker — Retries Indefinitely on Persistent Failure

## Problem Statement
`src/services/supply-chain/index.ts:fetchSectorDependency()` catches all errors and returns `emptySectorDependency`. While this prevents crashes, it means every call during a persistent outage (e.g., server restart, network partition) makes a live gRPC attempt before falling back. If the supply-chain panel calls this per-chokepoint on every render, a 30-chokepoint list during an outage = 30 sequential timeouts per render cycle.

## Findings
- **File:** `src/services/supply-chain/index.ts`
- **Code:**
  ```ts
  export async function fetchSectorDependency(iso2, hs2 = '27') {
    try {
      return await client.getSectorDependency({ iso2, hs2 });
    } catch {
      return { ...emptySectorDependency, iso2, hs2 };
    }
  }
  ```
- No timeout, no cached failure state, no back-off
- Minor issue today (called rarely), but will matter at scale
- Identified by kieran-typescript-reviewer during PR #2910 review

## Proposed Solutions

### Option A: Add a short timeout to the gRPC call
```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 3000);
return await client.getSectorDependency({ iso2, hs2 }, { signal: ac.signal });
```
Fails fast, reduces hung call duration.
**Effort:** Small | **Risk:** Low

### Option B: Deduplicate in-flight requests with a request Map
Cache the promise keyed by `${iso2}:${hs2}` — deduplicates concurrent calls for the same country.
**Effort:** Small | **Risk:** Low

## Recommended Action
_Combine A + B: timeout + in-flight dedup. Low-effort, prevents worst-case pile-up._

## Technical Details
- **Affected files:** `src/services/supply-chain/index.ts`

## Acceptance Criteria
- [ ] `fetchSectorDependency` times out within ~3s rather than hanging indefinitely
- [ ] Concurrent calls for the same `(iso2, hs2)` share one in-flight promise

## Work Log
- 2026-04-10: Identified by kieran-typescript-reviewer during PR #2910 review

## Resources
- PR: #2910
