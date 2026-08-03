-- Operational wrapper around the unchanged upstream dedupe/index migration.
-- The collector must be fully stopped before this migration runs. These bounds
-- make forgotten writers or an unexpectedly slow table fail closed, and the
-- transaction prevents a failed index build from committing the dedupe alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45min';
