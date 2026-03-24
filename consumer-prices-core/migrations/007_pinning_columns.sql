-- Task 1: Product pinning infrastructure
-- pin_disabled_at: soft-disable stale pins (NEVER delete product_matches rows)
-- consecutive_out_of_stock: tracks OOS streak for stale-pin detection
-- pin_error_count: tracks Firecrawl fetch/parse failures for stale-pin detection

ALTER TABLE product_matches
  ADD COLUMN IF NOT EXISTS pin_disabled_at TIMESTAMPTZ;

ALTER TABLE retailer_products
  ADD COLUMN IF NOT EXISTS consecutive_out_of_stock INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_error_count INT NOT NULL DEFAULT 0;

-- Partial index for fast O(1) pin lookup per (basket_item, retailer_product)
-- Only active, approved/auto matches need to be scanned for pins.
CREATE INDEX IF NOT EXISTS idx_pm_basket_active_pin
  ON product_matches(basket_item_id, retailer_product_id)
  WHERE pin_disabled_at IS NULL AND match_status IN ('auto', 'approved');
