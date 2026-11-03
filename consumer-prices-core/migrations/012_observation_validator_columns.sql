-- Compute these once on write so validation never detoasts the audit payload.
-- Missing validators retain the legacy admission policy.
ALTER TABLE price_observations
  ADD COLUMN validator_ok BOOLEAN GENERATED ALWAYS AS (
    CASE WHEN COALESCE(raw_payload_json->'validator', 'null'::jsonb) = 'null'::jsonb
      THEN TRUE
      ELSE (raw_payload_json->'validator'->>'ok')::boolean
    END
  ) STORED,
  ADD COLUMN validator_score DOUBLE PRECISION GENERATED ALWAYS AS (
    CASE WHEN COALESCE(raw_payload_json->'validator', 'null'::jsonb) = 'null'::jsonb
      THEN 1
      ELSE (raw_payload_json->'validator'->>'score')::double precision
    END
  ) STORED;
