-- Widen product_matches.match_status to include 'candidate' — the state written
-- for weak search hits that must not enter aggregates but whose evidence we
-- still want to keep so the next scrape doesn't re-pay the same Exa/Firecrawl
-- cost. Readers that filter on ('auto','approved') naturally exclude candidates.

ALTER TABLE product_matches DROP CONSTRAINT IF EXISTS product_matches_match_status_check;

ALTER TABLE product_matches
  ADD CONSTRAINT product_matches_match_status_check
  CHECK (match_status IN ('auto','review','approved','rejected','candidate'));
