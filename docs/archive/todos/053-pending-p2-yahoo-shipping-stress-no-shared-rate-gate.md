---
status: pending
priority: p2
issue_id: "053"
tags: [code-review, reliability, seeding, yahoo-finance, rate-limiting, pr-2375]
dependencies: []
---

## Problem Statement

The new `seedShippingStress` loop in `scripts/ais-relay.cjs` calls `fetchYahooChartDirect` for 5 shipping carrier tickers without sharing the `yahooGate` semaphore used by other Yahoo Finance callers. The existing gold standard (MEMORY.md) requires staggering Yahoo requests with 150ms delays and using `fetchYahooQuotesBatch()` with shared rate gating. Adding a parallel 15-minute loop that makes 5 additional Yahoo calls risks 429s that affect all other market data loops on the same process.

## Findings

- **File:** `scripts/ais-relay.cjs` — `seedShippingStress` makes 5 `fetchYahooChartDirect` calls with 150ms `setTimeout` stagger (correct stagger, but no shared gate with other Yahoo callers)
- **Gold standard (MEMORY.md):** "Stagger Yahoo requests with 150ms delays using `fetchYahooQuotesBatch()`. NEVER use `Promise.all` for Yahoo calls. Only 1 automated consumer"
- **New reality:** 2 automated consumers (market data + shipping stress) running independently
- **Impact:** Concurrent Yahoo calls from two loops can exceed Yahoo's undocumented rate limit, causing 429s that affect the market quotes loop — potentially staling all financial data panels

## Proposed Solutions

**Option A: Thread shipping stress calls through fetchYahooQuotesBatch / yahooGate (Recommended)**

Refactor `seedShippingStress` to use the shared `yahooGate` semaphore so all Yahoo calls — regardless of source — are serialized through a single gate.

- **Effort:** Small (extract shared gate, thread through both loops)
- **Risk:** Very low

**Option B: Add separate per-symbol delay and document the two-consumer reality**

Keep the 150ms stagger and add a comment documenting that two independent loops now hit Yahoo. Accept slightly higher rate-limit risk.

- **Effort:** Trivial
- **Risk:** Medium — if Yahoo rate limits tighten, both loops break together

**Option C: Move shipping stress seed to a separate Railway cron service**

Isolate shipping stress seeding to its own process so it cannot interfere with market data seeding.

- **Effort:** Medium
- **Risk:** Low — cleanest isolation, but adds operational complexity

## Acceptance Criteria

- [ ] `seedShippingStress` Yahoo calls share rate-limiting infrastructure with other Yahoo Finance callers in the relay
- [ ] No concurrent Yahoo calls without gating
- [ ] MEMORY.md `yahooGate` pattern documentation updated to reflect multiple callers

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review.
