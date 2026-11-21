-- Compute these once on write so validation never detoasts the audit payload.
-- Missing validators retain the legacy admission policy. A malformed `ok` or
-- `score` maps to NULL instead of failing the cast, so neither the table
-- rewrite nor a later insert can abort, and `IS TRUE` admission rejects it.
ALTER TABLE price_observations
  ADD COLUMN validator_ok BOOLEAN GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(raw_payload_json->'validator', 'null'::jsonb) = 'null'::jsonb THEN TRUE
      WHEN jsonb_typeof(raw_payload_json->'validator'->'ok') = 'boolean'
        THEN (raw_payload_json->'validator'->>'ok')::boolean
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN validator_score DOUBLE PRECISION GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(raw_payload_json->'validator', 'null'::jsonb) = 'null'::jsonb THEN 1
      WHEN jsonb_typeof(raw_payload_json->'validator'->'score') = 'number'
        THEN (raw_payload_json->'validator'->>'score')::double precision
      ELSE NULL
    END
  ) STORED;
