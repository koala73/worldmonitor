-- Operational scrape coverage for issue #5945.
-- Keep strict validator admission unchanged; this counter records observations
-- rejected by the validator so partial market publication is explainable.

ALTER TABLE scrape_runs
  ADD COLUMN IF NOT EXISTS rejected_count INT NOT NULL DEFAULT 0;

ALTER TABLE scrape_runs
  DROP CONSTRAINT IF EXISTS scrape_runs_rejected_count_nonnegative;

ALTER TABLE scrape_runs
  ADD CONSTRAINT scrape_runs_rejected_count_nonnegative CHECK (rejected_count >= 0);
