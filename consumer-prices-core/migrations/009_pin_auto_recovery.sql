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

-- ════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY GUARD (PR #3633 review round 2 P3)
-- ════════════════════════════════════════════════════════════════════════
-- The data resets below are NOT semantically idempotent: a second run
-- after scrapes have accumulated NEW failure counters would wipe legitimate
-- state (e.g. a product that's been genuinely OOS for 2 days would have
-- its counter zeroed, delaying its disable by another 3 days).
--
-- The standard `npm run migrate` runner guards against this via the
-- `schema_migrations` table (src/db/migrate.ts:32 — `if (appliedSet.has(version)) skip`).
-- BUT a hand-run by an operator (`psql -f migrations/009_*.sql`) bypasses
-- the runner and would re-execute the resets. The DO block below adds
-- defense-in-depth: it inspects schema_migrations directly and skips the
-- one-time data resets if 009 has already been recorded as applied.
--
-- The ALTER TABLE above is already idempotent via `IF NOT EXISTS` and runs
-- unconditionally — that's correct (it's pure schema, no data destruction).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '009_pin_auto_recovery') THEN
    RAISE NOTICE 'migration 009 already applied — skipping one-time data resets';
    RETURN;
  END IF;

  -- One-time data reset (HALF 1): clear sticky pin_disabled_at markers.
  -- Pre-fix snapshot (run before applying):
  --   SELECT COUNT(*) FROM product_matches WHERE pin_disabled_at IS NOT NULL;
  -- (WM 2026-05-08: 237 across the system; 8 baskets affected.)
  UPDATE product_matches
     SET pin_disabled_at = NULL
   WHERE pin_disabled_at IS NOT NULL;

  -- One-time data reset (HALF 2): also reset the trigger counters.
  -- ──────────────────────────────────────────────────────────────────────
  -- CRITICAL: clearing pin_disabled_at alone is NOT enough. Two SECOND-LEVEL
  -- gates in src/db/queries/matches.ts::getPinnedUrlsForRetailer ALSO
  -- exclude products from the pinned URL set:
  --
  --     AND rp.consecutive_out_of_stock < 3
  --     AND rp.pin_error_count < 3
  --
  -- Without resetting these counters, formerly-disabled products would have
  -- pin_disabled_at = NULL but counters at threshold (3+) — the scrape job
  -- would still skip them, the new auto-recovery code in scrape.ts would
  -- never run on them, and they'd remain effectively disabled despite the
  -- markers being cleared.
  --
  -- WM 2026-05-08 audit: 230 of 237 disabled matches (97%) have at least
  -- one counter ≥3 — without this reset, the migration is a no-op for
  -- 97% of the cases it's meant to fix.
  --
  -- Reset for ALL retailer_products (not just those with disabled matches):
  -- the existing 3-strike gate logic in scrape.ts will re-fire for any
  -- retailer_product that's still genuinely broken within ~3 days.
  UPDATE retailer_products
     SET consecutive_out_of_stock = 0,
         pin_error_count = 0
   WHERE consecutive_out_of_stock > 0
      OR pin_error_count > 0;
END $$;
