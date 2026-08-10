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

- The Umami service must run the WorldMonitor-managed image built by
  [`Dockerfile.umami`](../Dockerfile.umami), or another immutable image proven
  to contain both the composite `(session_id, data_key)` unique index and the
  `ON CONFLICT` upsert for `session_data`. A version label alone is
  insufficient; verify the deployed image digest and schema/index.
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

## Patched runtime image

Upstream Umami v3.2.0 still contains the
`updateMany()`/`create()` race from upstream issue `umami-software/umami#4183`.
The upstream repair landed after that release. `Dockerfile.umami` therefore
builds the exact v3.2.0 release commit
`2f6e2b5ff256862a081d9e74bed18a42ebf795e3` and applies only the source,
schema, migration, and regression test from upstream fix commit
`7c030e4c5da4b5fdf3e75e80787a0344b040ac8a`.

The image build fails if the patch no longer applies and runs the upstream
`saveSessionData` regression test before building the application. OCI labels
record both commits. The upstream migration was numbered `23` on its `dev`
branch; the overlay uses `21_update_session_data` because v3.2.0 ends at
migration `20`.

Deploy the image only through this sequence:

1. Take a restorable backup of the production `Postgres Umami` service and
   record its backup ID and completion time. Do not rely on volume capacity or
   deployment status as backup proof.
2. Restore that backup into a disposable database on comparable hardware and
   rehearse migration `21_update_session_data` there. Record the table size,
   duplicate count, migration duration, peak database CPU, and lock waits. The
   rehearsal must finish in under 30 minutes, leaving headroom below the
   migration's 45-minute per-statement timeout. If it does not, stop and design
   a longer offline migration window instead of raising the production timeout
   during the rollout.
3. Measure and record the production duplicate set before migration:

   ```sql
   SELECT count(*) - count(DISTINCT (session_id, data_key)) AS duplicate_rows
   FROM session_data;
   ```

4. Close public ingress, disable every Umami cron or operator task that can
   write analytics, and scale the old collector to **zero** replicas. One
   replica is still a live writer and is not sufficient. Sample the following
   query twice at least 60 seconds apart; proceed only when both samples report
   zero active client transactions and identical mutation counters for
   `session_data` and `website_event`:

   ```sql
   SELECT
     (SELECT count(*)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND (state <> 'idle' OR xact_start IS NOT NULL)) AS active_clients,
     relname,
     n_tup_ins,
     n_tup_upd,
     n_tup_del
   FROM pg_stat_user_tables
   WHERE relname IN ('session_data', 'website_event')
   ORDER BY relname;
   ```

   Treat a missing table row, a changed counter, or any active client as a
   failed drain. Do not start migration while the result is ambiguous.
5. Build `Dockerfile.umami`, record the candidate image digest and both OCI
   commit labels, then run that exact digest as a separately monitored one-off
   with the normal application command overridden to:

   ```bash
   pnpm exec prisma migrate deploy
   ```

   Give the one-off only `DATABASE_URL`, keep the collector at zero replicas,
   and require a zero exit status. Migration `21` wraps the unchanged upstream
   dedupe and unique-index statements in one transaction, with a 5-second lock
   timeout and a 45-minute per-statement timeout. Lock contention or timeout
   therefore aborts and rolls back the dedupe and index together.
6. Before starting any collector process, require all three database checks to
   pass: no duplicate composite keys, exactly one valid/ready unique index, and
   one successful, non-rolled-back Prisma migration record.

   ```sql
   SELECT count(*) - count(DISTINCT (session_id, data_key)) AS duplicate_rows
   FROM session_data;

   SELECT
     indexrelid::regclass::text AS index_name,
     indisunique,
     indisvalid,
     indisready,
     pg_get_indexdef(indexrelid) AS index_definition
   FROM pg_index
   WHERE indrelid = 'public.session_data'::regclass
     AND indexrelid =
       'public.session_data_session_id_data_key_key'::regclass;

   SELECT
     migration_name,
     finished_at,
     rolled_back_at,
     applied_steps_count
   FROM "_prisma_migrations"
   WHERE migration_name = '21_update_session_data';
   ```

   `duplicate_rows` must be `0`; the index query must return exactly one row
   with all three boolean fields true and the expected `(session_id, data_key)`
   definition; the migration query must return exactly one row with
   `finished_at` set, `rolled_back_at` null, and `applied_steps_count > 0`.
7. Configure the Railway `umami` service to build from the repository root
   with `/Dockerfile.umami`, preserving its existing `APP_SECRET`,
   `DATABASE_URL`, domain, health check, restart policy, CPU/memory limits, and
   `NODE_OPTIONS`. Start the patched service at one replica while public ingress
   remains closed. Verify the running image digest and OCI labels match the
   one-off, and verify its startup migration is a no-op against the already
   recorded migration.
8. Run an internal heartbeat and one write-canary burst against the patched
   service. Reopen public ingress only after those probes pass and the three
   database checks above still pass.
9. Require two consecutive scheduled write-canary runs with `12/12` accepted
   writes, a bounded production log query with zero `P2002` or
   `session_data_pkey` failures, and advancing `website_event.created_at`.
10. Keep production acceptance open until memory remains bounded through a
    comparable traffic window (at least 40,000 events/hour, the observed
    #6024 trigger region). A quiet-hour smoke test proves correctness, not load
    acceptance.

If the one-off exits non-zero, times out, or loses its database connection,
keep ingress closed and the collector at zero replicas. Capture the one-off
logs, then inspect the duplicate, index, and `_prisma_migrations` checks above;
do not blindly rerun or start either application image. Because the migration
is transactional, a normal SQL failure rolls back both data deletion and index
creation. After correcting the cause, mark the failed Prisma record rolled back
with the candidate image's `pnpm exec prisma migrate resolve --rolled-back
21_update_session_data`, rerun the same one-off digest, and repeat all three
checks. If database state is inconsistent or transaction outcome is unknown,
restore the recorded backup before retrying.

If the migration succeeds but the patched service fails its internal gate,
leave ingress closed and repair or roll back the application deployment. The
composite index is compatible with the old image, but the old update/create
path can still race; starting the old image is emergency containment, not
remediation. Restoring deleted duplicate rows or recovering from uncertain
schema state requires the recorded database backup.

## Retention contract

The relational analytics tables retain 90 days of raw data. A controlled
maintenance process runs [`scripts/umami-retention.sql`](../scripts/umami-retention.sql)
once per tick; it never loops inside one invocation. Each delete is capped at
10,000 rows, session-replay payloads are capped at 64 MiB per invocation, and
oversized replay rows are left for operator handling rather than force-deleted.
Child rows are deleted before parent rows, and a transaction-level advisory
lock prevents overlapping jobs. The job must not use `TRUNCATE` or an
unbounded `DELETE`.

The contract preserves website configuration and saved replay definitions.
Before enabling the job, take a database backup and verify the table names
against the deployed Umami schema. The SQL is intentionally not called by the
browser, the Vercel API, or the storage monitor.

## Retention runner

`Dockerfile.umami-retention` packages only a digest-pinned PostgreSQL client and
the reviewed retention SQL. Its registry lifecycle is active, so Railway runs it
at minutes 7, 22, 37, and 52 of each hour. Four bounded 10,000-row batches per
hour can retire up to 960,000 eligible event rows per day. A once-daily
10,000-row tick would run successfully while permanently falling behind, so it
is not an acceptable schedule.

Size the schedule against the rate rows **cross** the 90-day boundary, not
against intake. Those are different numbers whenever traffic is growing: when
retention was activated (#6148) the collector took 591,244 events/day while only
134,653/day aged past 90 days, because the boundary was still sweeping through
much quieter traffic from three months earlier. Intake is the figure that
matters for the steady state — once the boundary reaches present-day volume,
eligibility converges on it, and 960,000/day has to stay above it.

Provision the Railway `umami-retention` service from the repository root with
`/Dockerfile.umami-retention`. Configure `PGHOST`, `PGPORT`, `PGDATABASE`,
`PGUSER`, and `PGPASSWORD` as private variable references to `Postgres Umami`;
do not use its public TCP URL. The image defaults `PGCONNECT_TIMEOUT` to 10
seconds so a blackholed database connection exits within a bounded interval;
Railway may override it with another positive integer when operations require a
different connection budget. This timeout covers connection establishment;
the SQL file's transaction and statement timeouts cover work after connection.
The image invokes `psql -X` with `ON_ERROR_STOP=1`, so a missing connection
variable, connection timeout, or any SQL failure exits the cron non-zero.

The registry marks this service `lifecycle: active`, so the live Railway audit
requires it to exist and reconciles its cron. It was `planned` until #6148: a
planned entry stays subject to the static Dockerfile and registry checks while
the live audit neither requires the service nor reconciles its schedule, which
is what lets the service be provisioned and manually gated before activation.
Keep that order for any future runner — provision and complete the manual tick
while planned, and only set `lifecycle: active` in a separate reviewed change
once the runtime migration, write canary, and manual retention gate are green.

Before enabling the recurring schedule, run one manual tick after the backup
and record its duration, deleted-row counts, database CPU, and lock waits. Then
enable `7,22,37,52 * * * *` and observe at least four consecutive ticks. Stop
the cron if lock waits or collector latency rise; already completed bounded
deletes remain committed, and no further rows are touched while the cron is
disabled.

Two Railway mechanics decide whether that schedule is really running, and both
fail quietly:

- **The cron scheduler reads the active deployment's manifest, not the service
  config.** A `serviceInstanceUpdate` that sets `cronSchedule` returns success
  and reads back correctly from `railway environment config` while the
  deployment keeps firing on its old schedule. Redeploy after changing it, then
  confirm the schedule on the *deployment* manifest rather than the service.
- **A cron tick does not create a deployment record.** It re-runs the active
  deployment, so a tick is visible in that deployment's runtime logs and in the
  data — never as a new row in the deployments list.

The runtime-image migration and the retention runner are separate gates. Do
not start retention until the composite-index migration has succeeded and the
write canary is green.

## Capacity alert

`.github/workflows/umami-storage-monitor.yml` reads the Railway volume list
without mutating Railway or Postgres. It caches at most 30 days of samples and
reports the following capacity conditions:

- current usage is at least 80% (warning) or 90% (critical); or
- projected days to full are at most 30 (warning) or 14 (critical), once a
  24-hour growth baseline exists.

A warning emits a GitHub annotation but leaves the scheduled workflow green so
the 15-minute probe does not send repeated failed-run alerts during a bounded
retention drain. A critical condition fails the workflow. Input, Railway, or
state-processing errors also fail closed.

The monitor prints only volume size, growth, and projected headroom. It never
prints Railway variables, database URLs, analytics payloads, or user identity
fields.
