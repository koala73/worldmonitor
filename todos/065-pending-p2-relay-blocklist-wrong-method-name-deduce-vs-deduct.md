---
status: pending
priority: p2
issue_id: "065"
tags: [code-review, agent-native, correctness, analytical-frameworks]
dependencies: []
---

# Relay blocklist uses `'deduce-situation'` but actual method is `'deduct-situation'`

## Problem Statement
The `isWidgetEndpointAllowed` blocklist in `scripts/ais-relay.cjs` line ~8386 blocks `'deduce-situation'`. The actual RPC method name is `deduct-situation` (handler is `deductSituation`, the endpoint URL is `/api/intelligence/v1/deduct-situation`). The one-character typo (`deduce` vs `deduct`) means the blocklist entry never matches any real URL, allowing the widget-agent to call an expensive LLM inference endpoint that was intended to be restricted.

## Proposed Solution
Change `'deduce-situation'` → `'deduct-situation'` in the blocklist array.

## Technical Details
- File: `scripts/ais-relay.cjs` (line ~8386 — search for `deduce-situation`)
- Effort: Trivial | Risk: Low

## Acceptance Criteria
- [ ] `isWidgetEndpointAllowed` blocks `deduct-situation` requests from the widget-agent
- [ ] Test: widget-agent call to `/api/intelligence/v1/deduct-situation` is rejected

## Work Log
- 2026-03-28: Identified by agent-native-reviewer during PR #2386 review
