-- Consumer Prices Core: Fix computed_indices UPSERT with NULL retailer/category fields.
--
-- PostgreSQL treats NULL != NULL in unique constraints, so the existing
-- UNIQUE (basket_id, retailer_id, category, metric_date, metric_key)
-- constraint never fires when retailer_id or category are NULL.
-- This caused writeComputedIndex() to INSERT duplicates on every aggregate run.
--
-- Two affected cases:
--   1. Market-level metrics  (retailer_id IS NULL AND category IS NULL)
--   2. Category-level metrics (retailer_id IS NULL AND category IS NOT NULL)
--
-- Retailer-level rows (retailer_id IS NOT NULL) are not affected because
-- the existing constraint fires correctly when retailer_id has a value.

-- Step 1: Remove existing duplicates — keep the physically latest row per logical key.
DELETE FROM computed_indices a
USING computed_indices b
WHERE a.ctid < b.ctid
  AND a.basket_id = b.basket_id
  AND COALESCE(a.retailer_id::text, '') = COALESCE(b.retailer_id::text, '')
  AND COALESCE(a.category, '') = COALESCE(b.category, '')
  AND a.metric_date = b.metric_date
  AND a.metric_key = b.metric_key;

-- Step 2: Partial index for market-level metrics (no retailer, no category).
CREATE UNIQUE INDEX computed_indices_market_level_idx
  ON computed_indices (basket_id, metric_date, metric_key)
  WHERE retailer_id IS NULL AND category IS NULL;

-- Step 3: Partial index for category-level metrics (no retailer, has category).
CREATE UNIQUE INDEX computed_indices_category_level_idx
  ON computed_indices (basket_id, category, metric_date, metric_key)
  WHERE retailer_id IS NULL AND category IS NOT NULL;
