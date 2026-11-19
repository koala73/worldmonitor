-- The (basket item, product, price) rows each day's basket indices were
-- computed from. The next day's chain link divides by exactly these prices, so
-- a product joining, leaving, or being re-scraped after the aggregate cannot
-- move the index. Rows are replaced with the day's index rows in one
-- transaction by the aggregate job.
CREATE TABLE IF NOT EXISTS computed_index_inputs (
  basket_id           UUID NOT NULL REFERENCES baskets(id),
  metric_date         DATE NOT NULL,
  basket_item_id      UUID NOT NULL REFERENCES basket_items(id),
  retailer_product_id UUID NOT NULL REFERENCES retailer_products(id),
  price               NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (basket_id, metric_date, basket_item_id, retailer_product_id)
);
