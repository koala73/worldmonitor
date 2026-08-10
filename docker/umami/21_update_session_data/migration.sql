-- Operational wrapper around the unchanged upstream dedupe/index migration.
-- The collector must be fully stopped before this migration runs. These bounds
-- make forgotten writers or an unexpectedly slow table fail closed, and the
-- transaction prevents a failed index build from committing the dedupe alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45min';

WITH ranked_session_data AS (
  SELECT
    "session_data_id",
    ROW_NUMBER() OVER (
      PARTITION BY "session_id", "data_key"
      ORDER BY "created_at" DESC NULLS LAST, "session_data_id" DESC
    ) AS row_num
  FROM "session_data"
)
DELETE FROM "session_data"
USING ranked_session_data
WHERE "session_data"."session_data_id" = ranked_session_data."session_data_id"
  AND ranked_session_data.row_num > 1;

CREATE UNIQUE INDEX "session_data_session_id_data_key_key"
ON "session_data"("session_id", "data_key");

COMMIT;
