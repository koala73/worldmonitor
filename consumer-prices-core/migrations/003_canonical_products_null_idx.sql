-- Consumer Prices Core: Fix canonical_products upsert with NULL variant fields.
--
-- PostgreSQL treats NULL != NULL in unique constraints, so the existing
-- UNIQUE (canonical_name, brand_norm, category, variant_norm, size_value, size_unit)
-- constraint never fires when brand_norm/variant_norm/size_value/size_unit are all NULL.
-- This caused upsertCanonicalProduct() to INSERT duplicates on every scrape run.
--
-- This partial index covers the common case: no brand, no variant, no size specified.

CREATE UNIQUE INDEX canonical_products_name_category_null_idx
  ON canonical_products (canonical_name, category)
  WHERE brand_norm IS NULL
    AND variant_norm IS NULL
    AND size_value IS NULL
    AND size_unit IS NULL;
