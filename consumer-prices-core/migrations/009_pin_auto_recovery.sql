-- Task: Pin auto-recovery — symmetric counter for the sticky-disable
-- mechanism added in migration 007.
--
-- Background (WM 2026-05-08 incident):
--   /api/health flagged `consumerPricesSpread: EMPTY_DATA` because the
--   retailer-spread aggregation collapsed to 0 common items. Root cause
--   investigation: 48.5% of ALL product_matches were sticky-disabled via
--   pin_disabled_at — daily drip of 3-14 disables for ~3 weeks at the
--   nightly scrape-job time. Disabled-set match-score avg 0.99 vs
--   active-set 0.95: the disabler was killing the BEST matches whose
--   underlying products had transient blips (3 consecutive out-of-stock
--   or 3 pin-error scrapes). Once disabled, NEVER cleared — coverage
--   monotonically decayed.
--
--   See memory `sticky-disable-without-auto-recovery-decays` for the
--   pattern.
--
-- This migration ships TWO halves of the fix together (one without the
-- other doesn't restore service):
--
-- (A) Schema: add `consecutive_in_stock` counter to retailer_products,
--     symmetric mirror of the `consecutive_out_of_stock` counter from
--     migration 007. The application code (scrape.ts) increments this on
--     every in-stock observation and clears `pin_disabled_at` when it
--     crosses the same 3-consecutive threshold the disable side uses.
--
-- (B) Data: one-time reset of all existing pin_disabled_at markers. Code
--     alone leaves the existing 237 sticky records in their disabled
--     state forever (auto-recovery only fires when there's a successful
--     scrape, but a sticky-disabled record may not be scraped at all if
--     disable also cuts the scrape path). The reset lets the next scrape
--     cycle re-disable based on CURRENT product state — anything still
--     genuinely broken trips the 3-strike rule again within ~3 days; the
--     69% that were transiently OOS recover.

ALTER TABLE retailer_products
  ADD COLUMN IF NOT EXISTS consecutive_in_stock INT NOT NULL DEFAULT 0;

-- One-time data reset. Wrapped in a single statement — atomic.
-- Pre-fix snapshot (run before applying):
--   SELECT COUNT(*) FROM product_matches WHERE pin_disabled_at IS NOT NULL;
-- (WM 2026-05-08: 237 across the system; 8 baskets affected.)
UPDATE product_matches
   SET pin_disabled_at = NULL
 WHERE pin_disabled_at IS NOT NULL;
