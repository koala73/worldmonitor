-- World Monitor Umami relational retention contract.
--
-- Run this file from a controlled maintenance job with the Umami Postgres
-- DATABASE_URL. It is intentionally not invoked by the application or the
-- GitHub storage monitor. Run it once per maintenance tick; if more rows are
-- eligible, the next tick resumes the cleanup. Every statement is capped at
-- 10,000 rows (and replay payloads at 64 MiB); child rows are removed before
-- their parent rows.
--
-- Contract: retain 90 days of raw relational analytics. Do not TRUNCATE, use
-- an unbounded DELETE, remove website configuration, or remove saved replays.

BEGIN;

-- A singleton lock prevents overlapping maintenance jobs from selecting and
-- rescanning the same rows. The bounded lock timeout leaves collector writes
-- unaffected when an operator accidentally starts a second job.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('worldmonitor.umami.retention', 0));

-- Event data must be removed before the event row it references.
WITH doomed AS MATERIALIZED (
  SELECT data.event_data_id
  FROM event_data AS data
  JOIN website_event AS event ON event.event_id = data.website_event_id
  WHERE event.created_at IS NOT NULL
    AND event.created_at < now() - interval '90 days'
  ORDER BY event.created_at, data.event_data_id
  LIMIT 10000
)
DELETE FROM event_data AS data
USING doomed
WHERE data.event_data_id = doomed.event_data_id;

-- Only delete an event after its event_data children are gone. Repeating this
-- statement is safe when one event has more than one cleanup batch of data.
WITH doomed AS MATERIALIZED (
  SELECT event.event_id
  FROM website_event AS event
  WHERE event.created_at IS NOT NULL
    AND event.created_at < now() - interval '90 days'
    AND NOT EXISTS (
      SELECT 1 FROM event_data AS data WHERE data.website_event_id = event.event_id
    )
  ORDER BY event.created_at, event.event_id
  LIMIT 10000
)
DELETE FROM website_event AS event
USING doomed
WHERE event.event_id = doomed.event_id;

WITH doomed AS MATERIALIZED (
  SELECT revenue.revenue_id
  FROM revenue
  WHERE revenue.created_at IS NOT NULL
    AND revenue.created_at < now() - interval '90 days'
  ORDER BY revenue.website_id, revenue.created_at, revenue.revenue_id
  LIMIT 10000
)
DELETE FROM revenue
USING doomed
WHERE revenue.revenue_id = doomed.revenue_id;

WITH candidates AS MATERIALIZED (
  SELECT replay.website_id, replay.replay_id, replay.created_at,
    pg_column_size(replay.events) AS payload_bytes
  FROM session_replay AS replay
  WHERE replay.created_at IS NOT NULL
    AND replay.created_at < now() - interval '90 days'
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

WITH doomed AS MATERIALIZED (
  SELECT heatmap.heatmap_event_id
  FROM heatmap_event AS heatmap
  WHERE heatmap.created_at < now() - interval '90 days'
  ORDER BY heatmap.website_id, heatmap.created_at, heatmap.heatmap_event_id
  LIMIT 10000
)
DELETE FROM heatmap_event AS heatmap
USING doomed
WHERE heatmap.heatmap_event_id = doomed.heatmap_event_id;

WITH doomed AS MATERIALIZED (
  SELECT data.session_data_id
  FROM session_data AS data
  WHERE data.created_at IS NOT NULL
    AND data.created_at < now() - interval '90 days'
  ORDER BY data.created_at, data.session_data_id
  LIMIT 10000
)
DELETE FROM session_data AS data
USING doomed
WHERE data.session_data_id = doomed.session_data_id;

-- The fixed upstream schema includes session_link. Clean it only when the
-- deployed schema has it, so a pre-upgrade maintenance run remains safe.
DO $$
BEGIN
  IF to_regclass('public.session_link') IS NOT NULL THEN
    EXECUTE $cleanup$
      WITH doomed AS MATERIALIZED (
        SELECT link.website_id, link.distinct_id, link.session_id
        FROM session_link AS link
        WHERE link.created_at IS NOT NULL
          AND link.created_at < now() - interval '90 days'
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

-- A session is safe to remove only after all relational children have gone.
-- Saved replay definitions are deliberately not touched by this contract.
-- If session_link exists, leave sessions with a remaining link in place.
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
        AND session.created_at < now() - interval '90 days'
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
