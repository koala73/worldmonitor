-- Consumer Prices Core: Initial Schema
-- Run: psql $DATABASE_URL < migrations/001_initial.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Retailers ────────────────────────────────────────────────────────────────

CREATE TABLE retailers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  market_code   CHAR(2) NOT NULL,
  country_code  CHAR(2) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  adapter_key   VARCHAR(32) NOT NULL DEFAULT 'generic',
  base_url      TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE retailer_targets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id   UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  target_type   VARCHAR(32) NOT NULL CHECK (target_type IN ('category_url','product_url','search_query')),
  target_ref    TEXT NOT NULL,
  category_slug VARCHAR(64) NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_scraped_at TIMESTAMPTZ
);

-- ─── Products ─────────────────────────────────────────────────────────────────

CREATE TABLE canonical_products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(256) NOT NULL,
  brand_norm     VARCHAR(128),
  category       VARCHAR(64) NOT NULL,
  variant_norm   VARCHAR(128),
  size_value     NUMERIC(12,4),
  size_unit      VARCHAR(16),
  base_quantity  NUMERIC(12,4),
  base_unit      VARCHAR(16),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canonical_name, brand_norm, category, variant_norm, size_value, size_unit)
);

CREATE TABLE retailer_products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id         UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  retailer_sku        VARCHAR(128),
  canonical_product_id UUID REFERENCES canonical_products(id),
  source_url          TEXT NOT NULL,
  raw_title           TEXT NOT NULL,
  raw_brand           TEXT,
  raw_size_text       TEXT,
  image_url           TEXT,
  category_text       TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (retailer_id, source_url)
);

CREATE INDEX idx_retailer_products_retailer ON retailer_products(retailer_id);
CREATE INDEX idx_retailer_products_canonical ON retailer_products(canonical_product_id) WHERE canonical_product_id IS NOT NULL;

-- ─── Observations ─────────────────────────────────────────────────────────────

CREATE TABLE scrape_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id       UUID NOT NULL REFERENCES retailers(id),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  status            VARCHAR(16) NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','partial')),
  trigger_type      VARCHAR(16) NOT NULL DEFAULT 'scheduled'
                    CHECK (trigger_type IN ('scheduled','manual')),
  pages_attempted   INT NOT NULL DEFAULT 0,
  pages_succeeded   INT NOT NULL DEFAULT 0,
  errors_count      INT NOT NULL DEFAULT 0,
  config_version    VARCHAR(32) NOT NULL DEFAULT '1'
);

CREATE TABLE price_observations (
  id                  BIGSERIAL PRIMARY KEY,
  retailer_product_id UUID NOT NULL REFERENCES retailer_products(id),
  scrape_run_id       UUID NOT NULL REFERENCES scrape_runs(id),
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price               NUMERIC(12,2) NOT NULL,
  list_price          NUMERIC(12,2),
  promo_price         NUMERIC(12,2),
  currency_code       CHAR(3) NOT NULL,
  unit_price          NUMERIC(12,4),
  unit_basis_qty      NUMERIC(12,4),
  unit_basis_unit     VARCHAR(16),
  in_stock            BOOLEAN NOT NULL DEFAULT TRUE,
  promo_text          TEXT,
  raw_payload_json    JSONB NOT NULL DEFAULT '{}',
  raw_hash            VARCHAR(64) NOT NULL
);

CREATE INDEX idx_price_obs_product_time ON price_observations(retailer_product_id, observed_at DESC);
CREATE INDEX idx_price_obs_run ON price_observations(scrape_run_id);

-- ─── Matching ─────────────────────────────────────────────────────────────────

CREATE TABLE product_matches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_product_id   UUID NOT NULL REFERENCES retailer_products(id),
  canonical_product_id  UUID NOT NULL REFERENCES canonical_products(id),
  basket_item_id        UUID,
  match_score           NUMERIC(5,2) NOT NULL,
  match_status          VARCHAR(16) NOT NULL DEFAULT 'review'
                        CHECK (match_status IN ('auto','review','approved','rejected')),
  evidence_json         JSONB NOT NULL DEFAULT '{}',
  reviewed_by           VARCHAR(64),
  reviewed_at           TIMESTAMPTZ,
  UNIQUE (retailer_product_id, canonical_product_id)
);

-- ─── Baskets ──────────────────────────────────────────────────────────────────

CREATE TABLE baskets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  market_code   CHAR(2) NOT NULL,
  methodology   VARCHAR(16) NOT NULL CHECK (methodology IN ('fixed','value')),
  base_date     DATE NOT NULL,
  description   TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE basket_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  basket_id             UUID NOT NULL REFERENCES baskets(id) ON DELETE CASCADE,
  category              VARCHAR(64) NOT NULL,
  canonical_product_id  UUID REFERENCES canonical_products(id),
  substitution_group    VARCHAR(64),
  weight                NUMERIC(5,4) NOT NULL,
  qualification_rules_json JSONB,
  active                BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE product_matches ADD CONSTRAINT fk_pm_basket_item
  FOREIGN KEY (basket_item_id) REFERENCES basket_items(id);

-- ─── Analytics ────────────────────────────────────────────────────────────────

CREATE TABLE computed_indices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  basket_id            UUID NOT NULL REFERENCES baskets(id),
  retailer_id          UUID REFERENCES retailers(id),
  category             VARCHAR(64),
  metric_date          DATE NOT NULL,
  metric_key           VARCHAR(64) NOT NULL,
  metric_value         NUMERIC(14,4) NOT NULL,
  methodology_version  VARCHAR(16) NOT NULL DEFAULT '1',
  UNIQUE (basket_id, retailer_id, category, metric_date, metric_key)
);

CREATE INDEX idx_computed_indices_basket_date ON computed_indices(basket_id, metric_date DESC);

-- ─── Operational ──────────────────────────────────────────────────────────────

CREATE TABLE source_artifacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrape_run_id       UUID NOT NULL REFERENCES scrape_runs(id),
  retailer_product_id UUID REFERENCES retailer_products(id),
  artifact_type       VARCHAR(16) NOT NULL CHECK (artifact_type IN ('html','screenshot','parsed_json')),
  storage_key         TEXT NOT NULL,
  content_type        VARCHAR(64) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE data_source_health (
  retailer_id             UUID PRIMARY KEY REFERENCES retailers(id),
  last_successful_run_at  TIMESTAMPTZ,
  last_run_status         VARCHAR(16),
  parse_success_rate      NUMERIC(5,2),
  avg_freshness_minutes   NUMERIC(8,2),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Updated-at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER retailers_updated_at BEFORE UPDATE ON retailers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
