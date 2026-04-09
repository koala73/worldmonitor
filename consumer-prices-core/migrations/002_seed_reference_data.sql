-- Consumer Prices Core: Seed reference data
-- Inserts canonical products, the essentials-ae basket, and its 12 basket items.
-- Must match configs/baskets/essentials_ae.yaml exactly (same canonical names).
-- Run automatically by: tsx src/db/migrate.ts

-- ─── Canonical Products ───────────────────────────────────────────────────────

INSERT INTO canonical_products (canonical_name, category) VALUES
  ('Eggs Fresh 12 Pack',          'eggs'),
  ('Full Fat Fresh Milk 1L',      'dairy'),
  ('White Sliced Bread 600g',     'bread'),
  ('Basmati Rice 1kg',            'rice'),
  ('Sunflower Oil 1L',            'cooking_oil'),
  ('Whole Chicken Fresh 1kg',     'chicken'),
  ('Tomatoes Fresh 1kg',          'tomatoes'),
  ('Onions 1kg',                  'onions'),
  ('Drinking Water 1.5L',         'water'),
  ('White Sugar 1kg',             'sugar'),
  ('Processed Cheese Slices 200g','dairy'),
  ('Plain Yogurt 500g',           'dairy');

-- ─── Basket ───────────────────────────────────────────────────────────────────

INSERT INTO baskets (slug, name, market_code, methodology, base_date, description)
VALUES (
  'essentials-ae',
  'Essentials Basket UAE',
  'ae',
  'fixed',
  '2025-01-01',
  'Core household essentials tracked weekly across UAE retailers. Weighted to reflect a typical household of 4 in the UAE.'
);

-- ─── Basket Items (joined from canonical_products) ────────────────────────────
-- Each basket item links to its canonical product via canonical_product_id.
-- The weight, category, and canonical_name must mirror essentials_ae.yaml.

INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT
  b.id,
  cp.category,
  cp.id,
  v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Eggs Fresh 12 Pack',           0.12),
  ('Full Fat Fresh Milk 1L',       0.10),
  ('White Sliced Bread 600g',      0.08),
  ('Basmati Rice 1kg',             0.10),
  ('Sunflower Oil 1L',             0.08),
  ('Whole Chicken Fresh 1kg',      0.12),
  ('Tomatoes Fresh 1kg',           0.08),
  ('Onions 1kg',                   0.06),
  ('Drinking Water 1.5L',          0.08),
  ('White Sugar 1kg',              0.06),
  ('Processed Cheese Slices 200g', 0.06),
  ('Plain Yogurt 500g',            0.06)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-ae';
