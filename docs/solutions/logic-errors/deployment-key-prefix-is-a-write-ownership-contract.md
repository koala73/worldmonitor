---
title: "The deployment key prefix is a write-ownership contract — a helper's default silently picks which namespace preview reads"
date: 2026-09-04
category: logic-errors
module: server/_shared/redis.ts
problem_type: logic_error
component: database
severity: medium
symptoms:
  - "Preview deployments published an empty temporal-anomalies snapshot: the rebuild's count-source reads silently missed because the read helper prefixed keys nothing ever wrote"
  - "Nothing failed loudly — no error, no warning; the prefixed read just answered miss, the rebuild saw zero sources, and the route stamped a confidently empty result"
  - "The inverse had shipped earlier (#7575): a raw MGET helper read production rows while its sibling write helper prefixed, so a preview seeded its own namespace from production statistics and its writes never reached the rows it read"
root_cause: logic_error
resolution_type: code_fix
tags: [redis, key-prefix, vercel-env, preview, upstash-rest, seed-owned-keys, raw-flag, temporal-baselines]
---

# The deployment key prefix is a write-ownership contract

## Problem

One Upstash store is shared by two writer populations: Railway seeders, which write bare keys, and Vercel deployments, which namespace app-owned keys as `<env>:<sha>:` on anything that is not production (`getKeyPrefix()` in `server/_shared/redis.ts:41-46`). Every Redis read in `server/` must therefore name which population's namespace it targets — and a helper whose default picks the wrong one fails silently, only on preview.

## Symptoms

- Temporal-anomalies rebuilds on preview read `preview:<sha>:news:insights:v1` and `preview:<sha>:wildfire:fires:v1` — rows no seeder ever writes — so both count sources miss every cycle, baselines never sample, and the route publishes an empty snapshot.
- Production is byte-identical under the wrong default (`prefix = ''`), so nothing catches it locally or in CI until someone looks at a preview deployment.
- The mirror image predates it (#7575): `mgetJson` issued a raw `MGET` while `setCachedJson` prefixed, so preview reads production baselines and writes them into prefixed keys.

## What Didn't Work

- **Reading helpers in isolation.** `setCachedJson` prefixing and `mgetJson` not prefixing each looked correct until you paired them; the bug lived in the join, not in either helper.
- **The fix that removed the wrong helper also seeded a new one.** #7573 deleted `mgetJson` (and its unvalidated caller) for unrelated security reasons; its replacement read the seeder-owned count-source keys through `readCachedJson`'s prefixing default — inverting the asymmetry rather than closing it.
- **Tests that run with `VERCEL_ENV` unset.** Every prefix-less test passes under both defaults because the prefix collapses to `''`; the one preview test that existed asserted only the lock key, leaving the count-source namespace leg unguarded.

## Solution

Pass `raw = true` when reading seeder-owned keys, matching every other seed-key read in `server/` (the convention the `raw` docstring at `server/_shared/redis.ts:71-73` already states):

```ts
// server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts
await readCachedJson(sourceKey, true)
```

And pin the contract in a preview-mode regression test that asserts **both directions**: every `COUNT_SOURCE_KEYS` entry must be requested under its bare seeder-written name (and never under the prefixed name), while every app-owned key — hot-path snapshot GET, published snapshot POST, baseline sampling, seed-meta stamp — must stay inside the preview namespace, with no app-owned write reaching the bare production key.

## Why This Works

The prefix is not a caching detail; it is a write-ownership boundary. Reading a key through the wrong side of that boundary converts a namespace mismatch into a data answer: a prefixed read of a bare-written key returns miss (indistinguishable from genuinely empty data), and a bare write from a preview deploy lands in the production namespace (indistinguishable from production state). Choosing the namespace explicitly at each call site is the only place the decision can be correct, because only the call site knows who writes the key. Production masks wrong choices, which is exactly why they survive review and tests — the failure mode is preview-shaped, so the guard must be preview-shaped too.

## Prevention

- Every read of a seeder-owned key passes `raw = true`; every read/write of an app-owned key stays on the prefixing default. The `seed-meta:` name prefix is **not** the ownership test — `seed-meta:temporal:anomalies` is route-stamped (app-owned, prefixed) while seeder-written `seed-meta:*` keys are bare.
- Preview-mode tests must pin both directions for every app-owned write (snapshot, baselines, stamps), not just one leg — a raw snapshot write from a preview would clobber the live production row while every prefix-less test stays green.
- Derive test expectations from the source-of-truth constant (`COUNT_SOURCE_KEYS`) so a future configured source cannot silently escape coverage; tie the achieved-coverage stamp to the configured count so a missing stub fails loudly.
- The per-call-site magic boolean is the recurring failure surface (second bug of this class). A named `readSeedJson(key)` helper and a per-key ownership audit of the legacy `api/_upstash-json.js` layer are the proposed structural fixes (#7674).

## Related Issues

- #7575 — the original raw-MGET-vs-prefixed-write asymmetry (fixed at main by #7573's helper removal)
- #7673 — this fix: seeder-owned count sources read raw on preview (open as of this writing)
- #7674 — follow-up sweep: legacy `api/_upstash-json.js` helpers have no prefix support; seeders that prefix locally (`scripts/seed-military-bases.mjs:148`, `scripts/seed-physical-premiums.mjs:893`, `scripts/seed-wb-indicators.mjs:73`) vs. bare canonical seeders (`scripts/seed-insights.mjs:87`, `scripts/seed-fire-detections.mjs:24`)
