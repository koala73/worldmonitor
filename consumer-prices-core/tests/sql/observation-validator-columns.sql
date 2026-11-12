\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE price_observations (id int PRIMARY KEY, raw_payload_json jsonb NOT NULL);
INSERT INTO price_observations VALUES
  (1, '{}'),
  (2, '{"validator":null}'),
  (3, '{"validator":{"ok":true,"score":0.75}}'),
  (4, '{"validator":{"ok":true,"score":0.7499}}'),
  (5, '{"validator":{"ok":false,"score":0.95}}'),
  (6, '{"validator":{"ok":true,"score":0.95}}'),
  (7, '{"validator":{}}'),
  -- Malformed validators must not abort the rewrite; they fail closed.
  (9, '{"validator":{"ok":"yes","score":0.95}}'),
  (10, '{"validator":{"ok":true,"score":"high"}}'),
  (11, '{"validator":{"ok":1,"score":0.95}}'),
  (12, '{"validator":{"ok":true,"score":{"value":0.95}}}'),
  (13, '{"validator":"legacy"}'),
  -- Same as the former JavaScript check: no upper bound on score.
  (14, '{"validator":{"ok":true,"score":1.5}}');
\ir ../../migrations/012_observation_validator_columns.sql
DO $$
BEGIN
  IF (SELECT array_agg((validator_ok AND validator_score >= 0.75) IS TRUE ORDER BY id)
      FROM price_observations) IS DISTINCT FROM ARRAY[true,true,true,false,false,true,false,false,false,false,false,false,true] THEN
    RAISE EXCEPTION 'backfill admission mismatch';
  END IF;
END $$;
INSERT INTO price_observations VALUES (8, '{"validator":{"ok":true,"score":0.8}}');
DO $$
BEGIN
  IF (SELECT validator_ok AND validator_score = 0.8 FROM price_observations WHERE id = 8)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'generated columns did not follow insert';
  END IF;
END $$;
INSERT INTO price_observations VALUES (15, '{"validator":{"ok":"true","score":"0.9"}}');
DO $$
BEGIN
  IF (SELECT (validator_ok AND validator_score >= 0.75) IS TRUE FROM price_observations WHERE id = 15) THEN
    RAISE EXCEPTION 'malformed insert was admitted';
  END IF;
END $$;
UPDATE price_observations SET raw_payload_json = '{"validator":{"ok":false,"score":0.9}}' WHERE id = 8;
DO $$
BEGIN
  IF (SELECT NOT validator_ok AND validator_score = 0.9 FROM price_observations WHERE id = 8)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'generated columns did not follow update';
  END IF;
END $$;
ROLLBACK;
