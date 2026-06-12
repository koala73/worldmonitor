---
status: pending
priority: p2
issue_id: "051"
tags: [code-review, performance, analytical-frameworks]
dependencies: []
---

# Two sequential `sha256Hex` calls in `get-country-intel-brief.ts` — should be parallel

## Problem Statement
`get-country-intel-brief.ts` computes two async SHA-256 hashes sequentially: first `sha256Hex(contextSnapshot)` then `sha256Hex(frameworkRaw)`. Both use `crypto.subtle.digest` (Web Crypto API) and are independent. Running them sequentially doubles the cache key computation latency on every request, including cache hits. On Vercel Edge where cold-start budget is tight, this adds unnecessary overhead.

## Findings
- **`server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:38-39`**:
  ```ts
  const contextHash = contextSnapshot ? (await sha256Hex(contextSnapshot)).slice(0, 16) : 'base';
  const frameworkHash = frameworkRaw ? (await sha256Hex(frameworkRaw)).slice(0, 8) : '';
  ```
  These two awaits run sequentially.
- Flagged by: performance-oracle

## Proposed Solutions

### Option A: Parallelize with Promise.all (Recommended)
```ts
const [contextHash, frameworkHashFull] = await Promise.all([
  contextSnapshot ? sha256Hex(contextSnapshot) : Promise.resolve('base'),
  frameworkRaw ? sha256Hex(frameworkRaw) : Promise.resolve(''),
]);
const contextHashSliced = contextSnapshot ? contextHash.slice(0, 16) : 'base';
const frameworkHash = frameworkRaw ? frameworkHashFull.slice(0, 8) : '';
```
**Pros:** Half the wall-clock time for cache key computation | **Effort:** Trivial | **Risk:** Low

### Option B: Use sync FNV-1a `hashString` for the framework hash
The `frameworkRaw` is clamped to 2000 chars and is not an attacker-controlled collision-exploitable namespace. Use the existing sync `hashString()` for the framework hash, eliminating one async call entirely.
**Pros:** Zero async overhead for framework hash | **Cons:** FNV-1a is weaker than SHA-256 for collision resistance | **Effort:** Trivial | **Risk:** Low

## Technical Details
- File: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:38-39`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] The two SHA-256 calls run in parallel (or one is replaced with sync hash)
- [ ] Cache key output is identical to current implementation

## Work Log
- 2026-03-27: Identified during PR #2380 review by performance-oracle
