-- Per-run failure attribution for issue #6182.
--
-- #5945 (migration 010) made coverage loss VISIBLE as counts; this makes it
-- EXPLAINABLE. The adapter already classifies every failed candidate into a
-- bounded vocabulary (provider-cooldown, provider-error, missing-price,
-- quantity-as-price, currency-mismatch, title-mismatch, validator-rejected)
-- plus the loop's own parsed-zero-products / pin-validator-rejected /
-- unknown-error, and scrape.ts discarded it one line before persistence — so
-- "why is this market COVERAGE_PARTIAL" could only be answered by grepping
-- Railway logs, which is what both prior recovery rounds had to do.
--
-- One terminal reason is recorded per failure, so the map's values sum to
-- errors_count. Validator admission is unchanged: this is reporting only.

ALTER TABLE scrape_runs
  ADD COLUMN IF NOT EXISTS failure_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scrape_runs
  DROP CONSTRAINT IF EXISTS scrape_runs_failure_reasons_object;

-- Guards the shape the coverage snapshot reads back. A stray array or scalar
-- would flow into seed metadata and health as an unreadable diagnostic.
ALTER TABLE scrape_runs
  ADD CONSTRAINT scrape_runs_failure_reasons_object
  CHECK (jsonb_typeof(failure_reasons) = 'object');
