---
title: Upstash's max-request-size counts ONE command's result, and the rejection arrives as HTTP 200
date: 2026-08-02
category: integration-issues
module: digest-replay-log
problem_type: integration_issue
component: database
symptoms:
  - "Upstash alert: database hit the Max Request Size limit of 50MB at least 3 times in 15 minutes"
  - "`scripts/replay-digest-cooldown.mjs` exits 2 with `no records returned. Verify DIGEST_DEDUP_REPLAY_LOG=1 has been on` while the flag is demonstrably on and the keys hold data"
  - "No HTTP 413 anywhere in Railway logs across all 80 services"
  - "44 of 200 `digest:replay-log:v1:*` keys are individually over 50MiB"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components: [background_job, tooling]
tags: [upstash, redis, rest-api, lrange, pagination, silent-failure, http-200, limits, alerting]
---

# Upstash's max-request-size counts ONE command's result, and the rejection arrives as HTTP 200

## Problem

An Upstash alert reported the `worldmonitor` database hitting its 50MB max-request-size limit repeatedly. Two independent wrong assumptions in the codebase — about *what the limit measures* and *how the rejection is delivered* — meant the offending call had been failing silently for weeks, and the diagnostic harness built on top of it had been reporting a misleading cause.

## Symptoms

- Upstash alert: "hit Max Request Size limit of 50MB at least 3 times in the last 15 minutes"
- The `replay-digest-cooldown` harness exits 2 blaming the `DIGEST_DEDUP_REPLAY_LOG` feature flag, while the flag is on and the data is present
- Grepping every Railway service's deployment logs for `413` and `max request size` returns nothing
- `digest:replay-log:v1:*` day lists measure 54–154MB each

## What Didn't Work

Two plausible theories, both falsified by measurement rather than reading:

- **"A seeder is writing an oversized payload."** Scanned the whole keyspace (211,180 keys). The largest string value is `thermal:escalation:history:v1` at 8.09MB — nothing is near 50MB. Then reconstructed the per-tick `RPUSH` bodies for the replay-log writer from its retained entries across 165 ticks: the largest is 1.78MB. The write side was never involved.
- **"The limit counts a pipeline's total response."** This is what two in-repo comments asserted (`scripts/lib/story-track-batch-reader.mjs`, `scripts/lib/brief-embedding.mjs`), and it is false. A pipeline of 8 × `GET` returning **71.7MB total** succeeds with HTTP 200.

Searching logs for `413` was also a dead end — see below for why.

## Solution

Establish the real semantics empirically before fixing anything. Four probes against production settle it:

| Probe | Result |
| --- | --- |
| One command with a 60MB argument (`LPOS`) | `HTTP 413 — ERR max request size exceeded. Limit: 52428800, Actual: 60000028` |
| Pipeline of **60 commands totalling a 60MB request body**, largest single arg 1MB | **HTTP 200** — the body is not what's measured |
| Pipeline of 8 × `GET`, **71.7MB aggregate response** | **HTTP 200** — the aggregate response is not measured either |
| `LRANGE <154MB list> 0 -1` | **HTTP 200** + per-command error, `Actual: 144028523` |

The limit is **52,428,800 bytes measured per command, in both directions** — never on the HTTP body and never on a pipeline's aggregate. The two middle probes are the ones that matter: they are the only way to tell "per command" from "per request", and both a 60MB body and a 71.7MB response sail through as long as no *individual* command crosses the line. The rejection then has two different delivery mechanisms depending on which direction crossed it.

The fix (PR #6033) pages the read:

```js
// scripts/replay-digest-cooldown.mjs — was: `/lrange/${key}/0/-1`
export async function readReplayListPaged(url, token, key, opts = {}) {
  const pageSize = opts.pageSize ?? LRANGE_PAGE_SIZE; // 1000
  const out = [];
  let start = 0;
  for (;;) {
    const stop = start + pageSize - 1;
    const res = await fetchImpl(`${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`, ...);
    if (!res.ok) throw new Error(`LRANGE ${key} [${start}..${stop}] failed: HTTP ${res.status}`);
    const body = await res.json();
    // The load-bearing line: an HTTP 200 can still carry a rejection.
    if (body?.error) throw new Error(`LRANGE ${key} [${start}..${stop}] rejected by Upstash: ${body.error}`);
    const items = Array.isArray(body?.result) ? body.result : [];
    out.push(...items);
    if (items.length < pageSize) return out;
    start += pageSize;
  }
}
```

Plus two guardrails on the writer (`scripts/lib/brief-dedup-replay-log.mjs`): TTL 30d → 14d (matching `DEFAULT_REPLAY_DAYS`, the only consumer window that needs more than one day), and the per-day `LTRIM` cap 100,000 → 20,000 entries, so a whole-day read lands at ~31MB — 59% of the ceiling at the measured 1,545B mean entry size.

## Why This Works

Two distinct mistakes, each of which alone would have hidden the bug:

**1. The limit is per-command, not per-request.** Upstash's own docs phrase it as "the size of a single request," which reads as *HTTP request*. It is not — a `/pipeline` POST carrying N commands is bounded per command, so both a 60MB request body and a 71.7MB aggregate response pass, while any single `LRANGE key 0 -1` over a 144MB list is rejected. Three in-repo comments justified chunking by that misreading (two by "the aggregate pipeline response trips the per-request limit", one by "the pipeline body trips it at ~5,300 misses"). All three had the right remedy for the wrong reason: the chunking still helps — pipeline timeout budget and heap — but the stated reason would have misdirected the next reader, as it did here. All three are corrected in the same PR.

**2. Through `/pipeline` and the path-style REST API, the rejection is HTTP 200 with a per-command `error` field.** Only a bare oversized *request body* produces a 413. Every Upstash helper in this repo checks `resp.ok` and then reads `entry.result`, so an oversized-result rejection is indistinguishable from a cache miss:

```js
if (!resp.ok) return null;          // never fires — the status is 200
const body = await resp.json();
const list = Array.isArray(body?.result) ? body.result : [];  // body.result is undefined → []
```

That is why the harness reported "no records returned. Verify `DIGEST_DEDUP_REPLAY_LOG=1` has been on" — a read failure wearing a configuration failure's clothes — and why grepping Railway logs for `413` found nothing. `readJsonBatchFromUpstashWithStatus` in `api/_upstash-json.js` is the one helper that checks for the `error` key and is therefore immune.

A third-order effect worth knowing: `413` is **not** in `PERMANENT_4XX_STATUSES` (`scripts/_seed-utils.mjs`), so any seeder path that *does* send an oversized body gets retried by `withRetry` — one logical write becomes three alerts, which is exactly the "3 times in 15 minutes" shape the Upstash alert reports.

## Prevention

- **Never issue `LRANGE key 0 -1`, `HGETALL`, `SMEMBERS`, or `ZRANGE` over an unbounded collection against Upstash.** Page it. The sibling harnesses `scripts/sweep-topic-thresholds.mjs` and `scripts/brief-quality-report.mjs` already paged at 1,000; `replay-digest-cooldown.mjs` was the one that didn't.
- **Treat a per-command `error` field as a failure, loudly.** `resp.ok` is not sufficient for the Upstash REST API. A helper that maps a rejection onto the same value as a miss will always be debugged as the wrong problem first.
- **Size a growth cap against the limit that actually binds, and write the measurement into the comment.** The old 100,000-entry cap was sized against the 500MB max-*record*-size and left every day list unreadable. The assertion that replaced it encodes the invariant rather than a magic band:

  ```js
  const MEASURED_MEAN_ENTRY_BYTES = 1_545;      // 100,000 entries / 154.5MB, 2026-08-01
  const UPSTASH_MAX_COMMAND_BYTES = 52_428_800;
  assert.ok(REPLAY_LOG_MAX_ENTRIES_PER_DAY * MEASURED_MEAN_ENTRY_BYTES
    <= 0.75 * UPSTASH_MAX_COMMAND_BYTES);
  ```

- **When a paging helper takes a `pageSize`, guard it.** `pageSize = 0` puts `stop` at `-1`, reconstructing the exact unbounded read, and the short-page terminator (`items.length < pageSize`) can then never fire. Mutation-testing this guard did not produce a red test — it produced an **infinite loop**, which is a far worse regression than the one being fixed.
- **A vendor alert names a limit, not a caller.** Finding the caller here needed a full keyspace scan and per-command probes; log-grepping for the HTTP status the docs imply found nothing because that status is never emitted on this path.
- **Chunk for the reason that actually applies.** Batch sizes on these paths are justified by the pipeline timeout budget and heap, not by the size limit — at ~1.2KB per `HGETALL` and ~9.4KB per embedding `GET`/`SET`, no chunk size can trip a per-command ceiling. Writing the wrong reason into a comment is not harmless: it survives review, propagates to the next path by imitation, and sends the next investigator looking in the wrong direction.

## Related Issues

- PR #6033 — the fix (paging, TTL 30d → 14d, cap 100,000 → 20,000)
- [`umami-answers-http-200-when-it-drops-a-bot-write.md`](umami-answers-http-200-when-it-drops-a-bot-write.md) — the same failure class at a different vendor boundary: a 200 that means "rejected", and an alarm built on the wrong success signal
- [`seeder-auxiliary-redis-writes-timeout.md`](../database-issues/seeder-auxiliary-redis-writes-timeout.md) — adjacent Upstash write-path failure mode
