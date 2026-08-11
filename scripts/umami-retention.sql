-- World Monitor Umami relational retention contract.
--
-- Run this file from a controlled maintenance job with the Umami Postgres
-- connection variables. It is intentionally not invoked by the application or
-- the GitHub storage monitor. Run it once per maintenance tick; no statement
-- loops inside one invocation. If more rows are eligible, the next tick
-- resumes the cleanup. Every statement is capped at 10,000 rows (and replay
-- payloads at 64 MiB); child rows are removed before their parent rows.
--
-- Contract: retain 30 days of raw relational analytics. Do not TRUNCATE, use
-- an unbounded DELETE, remove website configuration, or remove saved replays.

-- The horizon is declared once so the tables cannot drift apart. 30 days is a
-- capacity number, not a taste one: at ~450,000 events/day and ~1,700 bytes
-- per event row (heap plus the 15 indexes Umami puts on website_event), plus
-- ~250,000 event_data rows/day at ~460 bytes, each retained day costs about
-- 0.9 GB. The Railway volume holds 50 GB, so 30 days settles near 27 GB and
-- 90 days needed about 79 GB — which is why the volume was filling (#6375).
\set retention_horizon '30 days'

-- The same horizon again, as a session setting, because psql substitutes a
-- variable only OUTSIDE quotes: `interval :'retention_horizon'` expands in a
-- plain statement, but the identical text inside the dollar-quoted body of a
-- DO block reaches the server literally and fails with `syntax error at or
-- near ":"`. The two DO blocks below therefore read this setting instead. Set
-- it from the variable so the horizon still has exactly one definition.
SET worldmonitor.umami_retention_horizon = :'retention_horizon';

-- A SESSION-level lock, taken with try-, not a transaction-level blocking one.
-- Each delete below now commits on its own, so the lock has to outlive any one
-- transaction. Taking it with pg_try_advisory_lock also makes an overlapping
-- tick exit 0 and say so, instead of dying on lock_timeout: a tick that skips
-- is a normal outcome, and only a tick that crashes should raise the alarm.
SELECT NOT pg_try_advisory_lock(hashtextextended('worldmonitor.umami.retention', 0))
  AS retention_locked_out \gset
\if :retention_locked_out
\echo 'umami-retention: a previous tick still holds the retention lock; skipping this tick'
\quit
\endif

-- Sized against measurement, not taste. One 10,000-row website_event batch
-- costs 15.0s against a warm cache — 14.7s of that is the 10,000 primary-key
-- probes of the delete itself, at ~1.5ms each — and roughly four times that
-- when the pages are cold. The previous 60s sat inside that range, so the tick
-- died on the cold half and rolled the whole transaction back (#6375). 300s
-- clears the cold case with margin.
--
-- This is a PER-STATEMENT budget, so it does not bound the tick: eight
-- statements could in principle run ~40 minutes, well past the 15-minute cron
-- period. That is survivable only because of the try-lock above — a tick that
-- arrives while the previous one is still working skips and exits 0 instead of
-- piling up or crashing. If you ever replace that lock with a blocking one,
-- this timeout becomes a wall-clock problem and needs a session deadline.
SET statement_timeout = '300s';
SET lock_timeout = '5s';

-- Each delete commits on its own. One transaction around all of them meant a
-- single slow statement discarded every earlier statement's finished work: the
-- production log for the 2026-08-10 12:22 tick reported `DELETE 1369`, then
-- cancelled the next statement on the timeout, and threw both away. Ordering
-- still runs children before parents, so an aborted tick leaves the database
-- further along rather than half-torn.
--
-- The precise guarantee, since there are no foreign keys here: every child that
-- EXISTED when the parent delete's statement snapshot opened is gone before its
-- parent. Under READ COMMITTED that says nothing about a child inserted after
-- that snapshot — the collector could in principle orphan one. It does not,
-- because it only ever writes children for events it is creating now, and this
-- file only ever deletes parents older than the horizon.

-- Event data goes first, and is bounded by its OWN created_at rather than by a
-- join to the parent event. Joining to the parent made this statement scan
-- every eligible parent (2.4 million of them) to find the few thousand that
-- still had children — 30s of the tick, growing with the backlog.
--
-- The two clocks are equivalent, measured rather than assumed: across
-- 1,027,145 parent/child pairs in two disjoint bands (the last 3 days, and the
-- oldest surviving 85-day-plus band) min and max skew were both 00:00:00 and
-- zero rows differed, because Umami writes an event and its event_data in the
-- same request. Re-measure that before widening this predicate. Even if a
-- child ever did lag, the parent delete below keeps its own NOT EXISTS guard,
-- so child-before-parent holds no matter which rows this statement picks.
BEGIN;
WITH doomed AS MATERIALIZED (
  SELECT data.event_data_id
  FROM event_data AS data
  WHERE data.created_at IS NOT NULL
    AND data.created_at < now() - interval :'retention_horizon'
  ORDER BY data.created_at, data.event_data_id
  LIMIT 10000
)
DELETE FROM event_data AS data
USING doomed
WHERE data.event_data_id = doomed.event_data_id;
COMMIT;

-- Only delete an event after its event_data children are gone. Repeating this
-- statement is safe when one event has more than one cleanup batch of data.
BEGIN;
WITH doomed AS MATERIALIZED (
  SELECT event.event_id
  FROM website_event AS event
  WHERE event.created_at IS NOT NULL
    AND event.created_at < now() - interval :'retention_horizon'
    AND NOT EXISTS (
      SELECT 1 FROM event_data AS data WHERE data.website_event_id = event.event_id
    )
  ORDER BY event.created_at, event.event_id
  LIMIT 10000
)
DELETE FROM website_event AS event
USING doomed
WHERE event.event_id = doomed.event_id;
COMMIT;

BEGIN;
WITH doomed AS MATERIALIZED (
  SELECT revenue.revenue_id
  FROM revenue
  WHERE revenue.created_at IS NOT NULL
    AND revenue.created_at < now() - interval :'retention_horizon'
  ORDER BY revenue.website_id, revenue.created_at, revenue.revenue_id
  LIMIT 10000
)
DELETE FROM revenue
USING doomed
WHERE revenue.revenue_id = doomed.revenue_id;
COMMIT;

BEGIN;
WITH candidates AS MATERIALIZED (
  SELECT replay.website_id, replay.replay_id, replay.created_at,
    pg_column_size(replay.events) AS payload_bytes
  FROM session_replay AS replay
  WHERE replay.created_at IS NOT NULL
    AND replay.created_at < now() - interval :'retention_horizon'
    AND pg_column_size(replay.events) <= 64 * 1024 * 1024
    AND NOT EXISTS (
      SELECT 1
      FROM session_replay_saved AS saved
      WHERE saved.website_id = replay.website_id
        AND saved.visit_id = replay.visit_id
    )
  ORDER BY replay.website_id, replay.created_at, replay.replay_id
  LIMIT 10000
), ranked AS MATERIALIZED (
  SELECT website_id, replay_id,
    SUM(payload_bytes) OVER (
      ORDER BY website_id, created_at, replay_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_payload_bytes
  FROM candidates
), doomed AS MATERIALIZED (
  SELECT replay_id
  FROM ranked
  WHERE cumulative_payload_bytes <= 64 * 1024 * 1024
)
DELETE FROM session_replay AS replay
USING doomed
WHERE replay.replay_id = doomed.replay_id;
COMMIT;

BEGIN;
WITH doomed AS MATERIALIZED (
  SELECT heatmap.heatmap_event_id
  FROM heatmap_event AS heatmap
  WHERE heatmap.created_at < now() - interval :'retention_horizon'
  ORDER BY heatmap.website_id, heatmap.created_at, heatmap.heatmap_event_id
  LIMIT 10000
)
DELETE FROM heatmap_event AS heatmap
USING doomed
WHERE heatmap.heatmap_event_id = doomed.heatmap_event_id;
COMMIT;

BEGIN;
WITH doomed AS MATERIALIZED (
  SELECT data.session_data_id
  FROM session_data AS data
  WHERE data.created_at IS NOT NULL
    AND data.created_at < now() - interval :'retention_horizon'
  ORDER BY data.created_at, data.session_data_id
  LIMIT 10000
)
DELETE FROM session_data AS data
USING doomed
WHERE data.session_data_id = doomed.session_data_id;
COMMIT;

-- The fixed upstream schema includes session_link. Clean it only when the
-- deployed schema has it, so a pre-upgrade maintenance run remains safe.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.session_link') IS NOT NULL THEN
    EXECUTE $cleanup$
      WITH doomed AS MATERIALIZED (
        SELECT link.website_id, link.distinct_id, link.session_id
        FROM session_link AS link
        WHERE link.created_at IS NOT NULL
          AND link.created_at
            < now() - current_setting('worldmonitor.umami_retention_horizon')::interval
        ORDER BY link.website_id, link.created_at, link.distinct_id, link.session_id
        LIMIT 10000
      )
      DELETE FROM session_link AS link
      USING doomed
      WHERE link.website_id = doomed.website_id
        AND link.distinct_id = doomed.distinct_id
        AND link.session_id = doomed.session_id
    $cleanup$;
  END IF;
END $$;
COMMIT;

-- A session is safe to remove only after all relational children have gone.
-- Saved replay definitions are deliberately not touched by this contract.
-- If session_link exists, leave sessions with a remaining link in place.
BEGIN;
DO $$
DECLARE
  session_link_guard text := '';
BEGIN
  IF to_regclass('public.session_link') IS NOT NULL THEN
    session_link_guard := $guard$
    AND NOT EXISTS (
      SELECT 1 FROM session_link AS link WHERE link.session_id = session.session_id
    )
    $guard$;
  END IF;

  EXECUTE format($cleanup$
    WITH doomed AS MATERIALIZED (
      SELECT session.session_id
      FROM session
      WHERE session.created_at IS NOT NULL
        AND session.created_at
          < now() - current_setting('worldmonitor.umami_retention_horizon')::interval
        AND NOT EXISTS (
          SELECT 1 FROM website_event AS event WHERE event.session_id = session.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_data AS data WHERE data.session_id = session.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM revenue WHERE revenue.session_id = session.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_replay AS replay WHERE replay.session_id = session.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM heatmap_event AS heatmap WHERE heatmap.session_id = session.session_id
        )
        %s
      ORDER BY session.created_at, session.session_id
      LIMIT 10000
    )
    DELETE FROM session
    USING doomed
    WHERE session.session_id = doomed.session_id
  $cleanup$, session_link_guard);
END $$;
COMMIT;
