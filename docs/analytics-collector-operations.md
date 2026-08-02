---
title: "Analytics Collector Operations"
description: "Operational contracts for the self-hosted Umami collector, its write canary, and its bounded Postgres retention policy."
---

# Analytics Collector Operations

World Monitor sends product analytics to the separately deployed Railway
`umami` service. Railway deployment status is not an application write-path
health signal: a healthy deployment can still return HTTP 500 from `POST
/api/send`.

## Write-path contract

- The Umami service must run an image built from upstream [commit `7c030e4`](https://github.com/umami-software/umami/commit/7c030e4) or
  a later commit that contains both the composite `(session_id, data_key)`
  unique index and the `ON CONFLICT` upsert for `session_data`. A version label
  alone is insufficient; verify the deployed image/digest and schema/index.
  The upgrade is an external Railway operation because its migration removes
  duplicate `session_data` rows before creating the unique index.
- The scheduled write canary sends 12 attempts per run: three synchronized
  bursts of a pageview, a named event, and two concurrent `identify` writes
  sharing one session-data key.
- Every attempt must return a real Umami receipt (`cache`, `sessionId`, and
  `visitId`). Any failed attempt, including `P2002/session_data_pkey`, fails the
  monitor. A green heartbeat or a green Railway deployment does not override a
  red write canary.
- Acceptance after a server upgrade is two consecutive scheduled runs with
  `12/12` accepted writes and zero `P2002` failures. Attach the exact deployed
  image/digest and the bounded production log query to the issue.
- During normal queue draining, browser writes are serialized through one
  in-flight transport slot. `pagehide` deliberately dispatches queued writes
  concurrently so keepalive delivery gets a chance to finish. The client does
  not blindly retry append-only conversion events after an ambiguous 5xx;
  identity snapshots may use their idempotent retry policy.

## Retention contract

The relational analytics tables retain 90 days of raw data. A controlled daily
maintenance job runs [`scripts/umami-retention.sql`](../scripts/umami-retention.sql)
once per tick; it never loops inside one invocation. Each delete is capped at
10,000 rows, session-replay payloads are capped at 64 MiB per invocation, and
oversized replay rows are left for operator handling rather than force-deleted.
Child rows are deleted before parent rows, and a transaction-level advisory lock
prevents overlapping jobs. The job must not use `TRUNCATE` or an unbounded
`DELETE`.

The contract preserves website configuration and saved replay definitions.
Before enabling the job, take a database backup and verify the table names
against the deployed Umami schema. The SQL is intentionally not called by the
browser, the Vercel API, or the storage monitor.

## Capacity alert

`.github/workflows/umami-storage-monitor.yml` reads the Railway volume list
without mutating Railway or Postgres. It caches at most 30 days of samples and
fails the workflow when either condition is true:

- current usage is at least 80% (warning) or 90% (critical); or
- projected days to full are at most 30 (warning) or 14 (critical), once a
  24-hour growth baseline exists.

The monitor prints only volume size, growth, and projected headroom. It never
prints Railway variables, database URLs, analytics payloads, or user identity
fields.
