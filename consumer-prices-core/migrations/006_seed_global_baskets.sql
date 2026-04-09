-- Consumer Prices Core: Seed the 9 new global market baskets.
-- Added in global expansion (PR #2063): AU, BR, CH, GB, IN, KE, SA, SG, US.
-- essentials-ae already exists from 002_seed_reference_data.sql.
--
-- Each basket requires:
--   1. canonical_products rows (ON CONFLICT DO NOTHING — reuses shared names where possible)
--   2. baskets row
--   3. basket_items rows joined from canonical_products

-- ─── Canonical Products ───────────────────────────────────────────────────────
-- Insert all new canonical names. Existing AE names are re-used where identical
-- (e.g. "Eggs Fresh 12 Pack", "Basmati Rice 1kg"). ON CONFLICT DO NOTHING skips dupes.

INSERT INTO canonical_products (canonical_name, category) VALUES
  -- AU
  ('Free Range Eggs 12 Pack',        'eggs'),
  ('Full Cream Milk 2L',             'dairy'),
  ('White Sandwich Bread 700g',      'bread'),
  ('Long Grain White Rice 1kg',      'rice'),
  ('Whole Chicken Fresh',            'chicken'),
  ('Tomatoes Fresh 1kg',             'tomatoes'),
  ('Brown Onions 1kg',               'onions'),
  ('Still Mineral Water 1.5L',       'water'),
  ('Tasty Cheddar Cheese 500g',      'dairy'),
  ('Natural Yogurt 500g',            'dairy'),
  -- BR
  ('Ovos Frescos 12 Unidades',       'eggs'),
  ('Leite Integral 1L',              'dairy'),
  ('Pão de Forma Branco 500g',       'bread'),
  ('Arroz Branco 1kg',               'rice'),
  ('Óleo de Soja 900ml',             'cooking_oil'),
  ('Frango Inteiro Resfriado 1kg',   'chicken'),
  ('Tomate Fresco 1kg',              'tomatoes'),
  ('Cebola 1kg',                     'onions'),
  ('Água Mineral 1.5L',              'water'),
  ('Açúcar Cristal 1kg',             'sugar'),
  ('Iogurte Natural 500g',           'dairy'),
  -- CH
  ('Fresh Eggs 10 Pack',             'eggs'),
  ('Vollmilch 1L',                   'dairy'),
  ('Weissbrot Sandwich 500g',        'bread'),
  ('Sonnenblumenöl 1L',              'cooking_oil'),
  ('Whole Chicken Fresh 1kg',        'chicken'),
  ('Tomaten 500g',                   'tomatoes'),
  ('Zwiebeln 1kg',                   'onions'),
  ('Mineralwasser 1.5L',             'water'),
  ('Zucker 1kg',                     'sugar'),
  ('Emmentaler Käse 200g',           'dairy'),
  ('Naturjoghurt 500g',              'dairy'),
  -- GB
  ('Free Range Eggs 12 Pack',        'eggs'),  -- same as AU, skipped by ON CONFLICT
  ('Semi Skimmed Milk 2 Pint',       'dairy'),
  ('White Sliced Bread 800g',        'bread'),
  ('Whole Chicken Fresh 1.5kg',      'chicken'),
  ('Still Water 6 x 1.5L',          'water'),
  ('Granulated White Sugar 1kg',     'sugar'),
  ('Mature Cheddar Cheese 400g',     'dairy'),
  -- IN
  ('Fresh Eggs 12 Pack',             'eggs'),
  ('Full Cream Milk 1L',             'dairy'),
  ('White Sandwich Bread 400g',      'bread'),
  ('Packaged Drinking Water 1L',     'water'),
  ('Fresh Paneer 200g',              'dairy'),
  ('Plain Curd Yogurt 400g',         'dairy'),
  -- KE
  ('Fresh Full Cream Milk 1L',       'dairy'),
  ('White Sliced Bread 400g',        'bread'),
  ('Long Grain Rice 1kg',            'rice'),
  ('Cooking Oil 1L',                 'cooking_oil'),
  ('Red Onions 1kg',                 'onions'),
  ('Processed Cheese 200g',          'dairy'),
  -- SA (shares most with AE — only new ones)
  ('White Sugar 1kg',                'sugar'),
  -- SG
  ('Fresh Full Cream Milk 1L',       'dairy'),  -- same as KE, skipped by ON CONFLICT
  ('Jasmine Rice 5kg',               'rice'),
  ('Sunflower Oil 2L',               'cooking_oil'),
  ('Cherry Tomatoes 500g',           'tomatoes'),
  ('Yellow Onions 500g',             'onions'),
  ('Mineral Water 1.5L',             'water'),
  -- US
  ('Whole Milk 1 Gallon',            'dairy'),
  ('White Sandwich Bread Loaf',      'bread'),
  ('Long Grain White Rice 2lb',      'rice'),
  ('Vegetable Oil 48oz',             'cooking_oil'),
  ('Tomatoes Fresh',                 'tomatoes'),
  ('Yellow Onions 3lb',              'onions'),
  ('Drinking Water 24 Pack 16oz',    'water'),
  ('Granulated White Sugar 4lb',     'sugar'),
  ('Cheddar Cheese Slices 8oz',      'dairy'),
  ('Plain Yogurt 32oz',              'dairy')
ON CONFLICT (canonical_name, category)
  WHERE brand_norm IS NULL AND variant_norm IS NULL AND size_value IS NULL AND size_unit IS NULL
  DO NOTHING;

-- ─── Baskets ──────────────────────────────────────────────────────────────────

INSERT INTO baskets (slug, name, market_code, methodology, base_date, description) VALUES
  ('essentials-au', 'Essentials Basket Australia',    'au', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Australian grocery retailers.'),
  ('essentials-br', 'Essentials Basket Brazil',       'br', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Brazilian grocery retailers.'),
  ('essentials-ch', 'Essentials Basket Switzerland',  'ch', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Swiss grocery retailers.'),
  ('essentials-gb', 'Essentials Basket UK',           'gb', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across UK grocery retailers.'),
  ('essentials-in', 'Essentials Basket India',        'in', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Indian grocery retailers.'),
  ('essentials-ke', 'Essentials Basket Kenya',        'ke', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Kenyan grocery retailers.'),
  ('essentials-sa', 'Essentials Basket Saudi Arabia', 'sa', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Saudi grocery retailers.'),
  ('essentials-sg', 'Essentials Basket Singapore',    'sg', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across Singapore grocery retailers.'),
  ('essentials-us', 'Essentials Basket USA',          'us', 'fixed', '2025-01-01',
   'Core household essentials tracked weekly across US grocery retailers.')
ON CONFLICT (slug) DO NOTHING;

-- ─── Basket Items: AU ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Free Range Eggs 12 Pack',    0.12),
  ('Full Cream Milk 2L',         0.10),
  ('White Sandwich Bread 700g',  0.08),
  ('Long Grain White Rice 1kg',  0.08),
  ('Sunflower Oil 1L',           0.07),
  ('Whole Chicken Fresh',        0.12),
  ('Tomatoes Fresh 1kg',         0.08),
  ('Brown Onions 1kg',           0.06),
  ('Still Mineral Water 1.5L',   0.07),
  ('White Sugar 1kg',            0.06),
  ('Tasty Cheddar Cheese 500g',  0.08),
  ('Natural Yogurt 500g',        0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-au';

-- ─── Basket Items: BR ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Ovos Frescos 12 Unidades',     0.10),
  ('Leite Integral 1L',            0.12),
  ('Pão de Forma Branco 500g',     0.08),
  ('Arroz Branco 1kg',             0.12),
  ('Óleo de Soja 900ml',           0.09),
  ('Frango Inteiro Resfriado 1kg', 0.12),
  ('Tomate Fresco 1kg',            0.08),
  ('Cebola 1kg',                   0.07),
  ('Água Mineral 1.5L',            0.06),
  ('Açúcar Cristal 1kg',           0.08),
  ('Iogurte Natural 500g',         0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-br';

-- ─── Basket Items: CH ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Fresh Eggs 10 Pack',        0.12),
  ('Vollmilch 1L',              0.10),
  ('Weissbrot Sandwich 500g',   0.08),
  ('Basmati Rice 1kg',          0.08),
  ('Sonnenblumenöl 1L',         0.07),
  ('Whole Chicken Fresh 1kg',   0.12),
  ('Tomaten 500g',              0.08),
  ('Zwiebeln 1kg',              0.06),
  ('Mineralwasser 1.5L',        0.07),
  ('Zucker 1kg',                0.06),
  ('Emmentaler Käse 200g',      0.08),
  ('Naturjoghurt 500g',         0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-ch';

-- ─── Basket Items: GB ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Free Range Eggs 12 Pack',    0.12),
  ('Semi Skimmed Milk 2 Pint',   0.10),
  ('White Sliced Bread 800g',    0.08),
  ('Basmati Rice 1kg',           0.08),
  ('Sunflower Oil 1L',           0.07),
  ('Whole Chicken Fresh 1.5kg',  0.12),
  ('Tomatoes Fresh 1kg',         0.08),
  ('Brown Onions 1kg',           0.06),
  ('Still Water 6 x 1.5L',      0.07),
  ('Granulated White Sugar 1kg', 0.06),
  ('Mature Cheddar Cheese 400g', 0.08),
  ('Natural Yogurt 500g',        0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-gb';

-- ─── Basket Items: IN ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Fresh Eggs 12 Pack',          0.10),
  ('Full Cream Milk 1L',          0.12),
  ('White Sandwich Bread 400g',   0.07),
  ('Basmati Rice 1kg',            0.12),
  ('Sunflower Oil 1L',            0.09),
  ('Whole Chicken Fresh 1kg',     0.12),
  ('Tomatoes Fresh 1kg',          0.09),
  ('Onions 1kg',                  0.09),
  ('Packaged Drinking Water 1L',  0.06),
  ('White Sugar 1kg',             0.07),
  ('Fresh Paneer 200g',           0.06),
  ('Plain Curd Yogurt 400g',      0.07)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-in';

-- ─── Basket Items: KE ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Fresh Eggs 12 Pack',        0.12),
  ('Fresh Full Cream Milk 1L',  0.12),
  ('White Sliced Bread 400g',   0.08),
  ('Long Grain Rice 1kg',       0.10),
  ('Cooking Oil 1L',            0.09),
  ('Whole Chicken Fresh 1kg',   0.12),
  ('Tomatoes Fresh 1kg',        0.09),
  ('Red Onions 1kg',            0.07),
  ('Drinking Water 1.5L',       0.06),
  ('White Sugar 1kg',           0.07),
  ('Processed Cheese 200g',     0.06),
  ('Plain Yogurt 500g',         0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-ke';

-- ─── Basket Items: SA ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Eggs Fresh 12 Pack',            0.12),
  ('Full Fat Fresh Milk 1L',        0.10),
  ('White Sliced Bread 600g',       0.08),
  ('Basmati Rice 1kg',              0.10),
  ('Sunflower Oil 1L',              0.08),
  ('Whole Chicken Fresh 1kg',       0.12),
  ('Tomatoes Fresh 1kg',            0.08),
  ('Onions 1kg',                    0.06),
  ('Drinking Water 1.5L',           0.08),
  ('White Sugar 1kg',               0.06),
  ('Processed Cheese Slices 200g',  0.06),
  ('Plain Yogurt 500g',             0.06)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-sa';

-- ─── Basket Items: SG ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Fresh Eggs 10 Pack',          0.12),
  ('Fresh Full Cream Milk 1L',    0.10),
  ('White Sandwich Bread 400g',   0.08),
  ('Jasmine Rice 5kg',            0.10),
  ('Sunflower Oil 2L',            0.08),
  ('Whole Chicken Fresh 1kg',     0.12),
  ('Cherry Tomatoes 500g',        0.08),
  ('Yellow Onions 500g',          0.06),
  ('Mineral Water 1.5L',          0.07),
  ('White Sugar 1kg',             0.06),
  ('Processed Cheese Slices 200g',0.06),
  ('Plain Yogurt 500g',           0.07)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-sg';

-- ─── Basket Items: US ─────────────────────────────────────────────────────────
INSERT INTO basket_items (basket_id, category, canonical_product_id, weight)
SELECT b.id, cp.category, cp.id, v.weight
FROM baskets b
CROSS JOIN LATERAL (VALUES
  ('Eggs Fresh 12 Pack',              0.12),
  ('Whole Milk 1 Gallon',             0.10),
  ('White Sandwich Bread Loaf',       0.08),
  ('Long Grain White Rice 2lb',       0.08),
  ('Vegetable Oil 48oz',              0.07),
  ('Whole Chicken Fresh',             0.12),
  ('Tomatoes Fresh',                  0.08),
  ('Yellow Onions 3lb',               0.06),
  ('Drinking Water 24 Pack 16oz',     0.07),
  ('Granulated White Sugar 4lb',      0.06),
  ('Cheddar Cheese Slices 8oz',       0.08),
  ('Plain Yogurt 32oz',               0.08)
) AS v(canonical_name, weight)
JOIN canonical_products cp ON cp.canonical_name = v.canonical_name
WHERE b.slug = 'essentials-us';
