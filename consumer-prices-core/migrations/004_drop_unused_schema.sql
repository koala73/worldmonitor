-- Consumer Prices Core: Drop unused schema
--
-- source_artifacts: table defined but never written to by any job.
-- avg_freshness_minutes: column in data_source_health that scrape.ts never populates;
--   freshness is computed live from last_successful_run_at in buildFreshnessSnapshot.

DROP TABLE source_artifacts;

ALTER TABLE data_source_health DROP COLUMN avg_freshness_minutes;
