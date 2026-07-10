---
status: pending
priority: p2
issue_id: 184
tags: [code-review, phase-0, regional-intelligence, persistence, consistency, redis]
dependencies: []
---

# Upstash /pipeline is not transactional - partial failure leaves inconsistent snapshot state

## Problem Statement
`scripts/regional-snapshot/persist-snapshot.mjs:56-73` issues 6 commands via `/pipeline` (SET timestamp, SET by-id, SET latest, ZADD index, ZREMRANGEBYSCORE, DEL live). Pipeline executes sequentially but not atomically. Partial failure leaves inconsistent state (latest pointer to a snapshot not in the index, or vice versa). Phase 1 may rely on the index to enumerate accessible snapshots and trip on the inconsistency.

## Findings
- `/pipeline` is batched but not transactional on Upstash
- 6 writes cover 3 state shapes: timestamp view, id view, latest pointer, index
- Partial failure surfaces as silent drift between pointer and index
- No repair job exists

## Proposed Solutions

### Option 1: Use /multi-exec for atomic persistence
Upstash supports MULTI/EXEC transactions via `/multi-exec` endpoint.

**Pros:** All-or-nothing guarantee; no inconsistent state
**Cons:** Slightly more expensive; needs a small client change
**Effort:** Medium
**Risk:** Low

### Option 2: Document partial-persist contract + repair job
Accept non-atomicity; write a repair job that reconciles latest/index on next run.

**Pros:** Keeps existing pipeline code
**Cons:** Runtime readers still see drift until repair fires; more complex
**Effort:** Medium
**Risk:** Low

## Recommended Action


## Technical Details
File: `scripts/regional-snapshot/persist-snapshot.mjs:56-73`
Commands in the current pipeline:
1. SET snapshot:ts:{region}:{ts}
2. SET snapshot:id:{region}:{id}
3. SET snapshot:latest:{region}
4. ZADD snapshot:index:{region}
5. ZREMRANGEBYSCORE snapshot:index:{region}
6. DEL snapshot:live:{region}

## Acceptance Criteria
- [ ] Use /multi-exec for atomic persistence OR
- [ ] Document the partial-persist contract and add a repair job

## Work Log

## Resources
- PR #2940
- PR #2942
