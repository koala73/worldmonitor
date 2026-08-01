---
title: TTL staleness audits must ignore prose comments
date: 2026-07-14
category: logic-errors
module: seeder-health
problem_type: logic_error
component: testing_framework
symptoms:
  - "The TTL-outlives-staleness fleet guard can silently skip a seeder when a comment mentions maxStaleMin before the runSeed options"
  - "Existing TTL debt can be omitted from the frozen allowlist while the guard still passes"
root_cause: missing_validation
resolution_type: test_fix
severity: high
related_components: [background_job, tooling]
tags: [seeders, health-monitoring, ttl, staleness, static-analysis]
---

# TTL staleness audits must ignore prose comments

## Problem

PR #5317 adds a fleet guard requiring a seeded key's `ttlSeconds` to outlive
its `maxStaleMin` health gate. Its initial extractor searched the entire source
file for those labels. A prose comment before the real options could therefore
be parsed as configuration, making the audit skip that seeder instead of
failing loudly.

## Symptoms

- `seed-aviation.mjs` documents a separate health threshold before its
  `runSeed` options; the broad `maxStaleMin` search captured `240)`, which is
  not a numeric expression.
- Once the extractor was constrained to actual option lines, it found two
  pre-existing violations: `seed-jodi-gas.mjs` and `seed-research.mjs`.

## What Didn't Work

- A global `src.match(/maxStaleMin.../)` search treated comments as config.
- The audit's total-count floor caught a collapse in coverage but not selective
  omissions, so the false pass remained possible.

## Solution

Anchor both property matches to option lines:

```js
const ttlM = src.match(/^\s*ttlSeconds:\s*([^,\n]+)/m);
const staleM = src.match(/^\s*maxStaleMin:\s*([^,\n]+)/m);
```

Add a regression assertion that the fleet audit includes
`seed-aviation.mjs`. Keep the two already-existing violations in the explicit
`KNOWN_VIOLATIONS` set rather than changing unrelated production TTLs; the
allowlist remains visible debt and the guard still rejects new violations.

## Why This Works

Configuration properties in the seed scripts are indented option lines, while
the misleading text is comment prose. Anchoring the match preserves the
existing literal, arithmetic, and same-file constant resolution while excluding
comments. The aviation assertion pins the precise prior failure mode, and the
allowlist's anti-rot test ensures every deferred item remains a real violation.

## Prevention

- Treat source-text audits as parsers: never search comments and configuration
  with the same unconstrained pattern.
- Pair coverage floors with a representative regression fixture for every
  discovered blind spot.
- When a corrected extractor finds legacy debt, record it explicitly instead
  of weakening the invariant or changing unrelated production settings.

## Related Issues

- PR #5317 - fleet TTL-outlives-staleness guard and its parser repair.
- [Health must not grade a deliberately-unconfigured optional source](health-must-not-grade-an-unconfigured-optional-source.md)
  - another health classification boundary where preserving state distinctions
  prevents false alerts.
