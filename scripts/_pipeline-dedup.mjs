// @ts-check
//
// Pure deterministic deduplication for the GEM pipeline import. NOT an entry
// point — see scripts/import-gem-pipelines.mjs for the orchestrator.
//
// Match rule (BOTH must hold):
//   1. Endpoint distance ≤ 5 km (haversine, route-direction-flipped pair-aware
//      so Mozyr→Adamowo and Adamowo→Mozyr count as the same).
//   2. Name token Jaccard ≥ 0.6 (lowercased word tokens, stopwords removed).
//
// Conflict resolution: existing row WINS. Hand-curated rows have richer
// evidence (operator statements, sanction refs, classifier confidence ≥ 0.7)
// that GEM's minimum-viable evidence shouldn't overwrite. The dedup function
// returns { toAdd, skippedDuplicates } so the caller can audit which GEM
// candidates were absorbed by existing rows.
//
// Determinism: zero Date.now() / Math.random() / Set ordering reliance. Two
// invocations on identical inputs produce identical outputs.

const STOPWORDS = new Set([
  'pipeline', 'pipelines', 'system', 'systems', 'line', 'lines', 'network',
  'route', 'project', 'the', 'and', 'of', 'a', 'an',
]);

const MATCH_DISTANCE_KM = 5;
const MATCH_JACCARD_MIN = 0.6;
// When the candidate's tokenized name equals the existing row's tokenized
// name (Jaccard == 1.0 after stopword removal), accept the match if ANY
// endpoint pairing is within MATCH_NAME_IDENTICAL_DISTANCE_KM. Catches PR
// #3406 review's Dampier-Bunbury case: GEM digitized only the southern
// 60% of the line, so the average-endpoint distance was 287km but the
// shared Bunbury terminus matched within 13.7km. A pure name-only rule
// would false-positive on coincidental collisions in different oceans
// (e.g. unrelated "Nord Stream 1" in the Pacific), so we still require
// SOME geographic anchor.
const MATCH_NAME_IDENTICAL_DISTANCE_KM = 25;
const EARTH_RADIUS_KM = 6371;

/**
 * Haversine great-circle distance in km between two lat/lon points.
 */
function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return EARTH_RADIUS_KM * c;
}

/**
 * Average endpoint distance between two pipelines, considering both forward
 * and reversed pairings. The smaller of the two is returned so a route
 * direction flip doesn't appear as a different pipeline.
 */
function averageEndpointDistanceKm(a, b) {
  const forward =
    (haversineKm(a.startPoint, b.startPoint) + haversineKm(a.endPoint, b.endPoint)) / 2;
  const reversed =
    (haversineKm(a.startPoint, b.endPoint) + haversineKm(a.endPoint, b.startPoint)) / 2;
  return Math.min(forward, reversed);
}

/**
 * Minimum of all four cross-pairings between candidate and existing endpoints.
 * Used by the name-identical short-circuit: if the candidate digitizes a
 * different segment of the same physical pipeline, only ONE endpoint pair
 * may match closely (e.g. Dampier-Bunbury: shared Bunbury terminus 13.7 km,
 * other end 560 km away because GEM stopped at Onslow vs the full Dampier
 * route). A tight average would miss this; the min of the four pairings
 * doesn't.
 */
function minPairwiseEndpointDistanceKm(a, b) {
  return Math.min(
    haversineKm(a.startPoint, b.startPoint),
    haversineKm(a.startPoint, b.endPoint),
    haversineKm(a.endPoint, b.startPoint),
    haversineKm(a.endPoint, b.endPoint),
  );
}

/**
 * Tokenize a name: lowercased word tokens, ASCII-only word boundaries,
 * stopwords removed. Stable across invocations.
 */
function tokenize(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks (diacritics) so "Limón" → "limon", not "limo'n".
    // Range ̀-ͯ covers Combining Diacritical Marks per Unicode.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B| over token sets.
 */
function jaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const unionSize = setA.size + setB.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * Decide if a candidate matches an existing row.
 *
 * Two acceptance paths:
 *   (a) Token sets are IDENTICAL (Jaccard == 1.0 after stopword removal) —
 *       the same pipeline regardless of how either source digitized its
 *       endpoints. Catches the Dampier-Bunbury case (PR #3406 review):
 *       GEM's GeoJSON terminus was 13.7 km from the curated terminus
 *       (just over the 5 km distance gate) but both names tokenize to
 *       {dampier, to, bunbury, natural, gas}, so they are clearly the
 *       same physical pipeline.
 *   (b) Distance ≤ 5 km AND Jaccard ≥ 0.6 — the original conjunctive rule
 *       for slight name-variation cases (e.g. "Druzhba Pipeline" vs
 *       "Druzhba Oil Pipeline").
 */
function isDuplicate(candidate, existing) {
  const sim = jaccard(candidate.name, existing.name);
  // Path (a): identical token-set + at least one endpoint pair within 25 km.
  // The geographic anchor distinguishes the Dampier-Bunbury case from a
  // theoretical name-collision in a different ocean.
  if (sim >= 1.0) {
    const minDist = minPairwiseEndpointDistanceKm(candidate, existing);
    if (minDist <= MATCH_NAME_IDENTICAL_DISTANCE_KM) return true;
    // Identical names but no endpoint near each other → distinct pipelines
    // sharing a name (rare but real). Fall through to the conjunctive rule
    // below, which will return false because Jaccard 1.0 with > 25km min
    // pair always exceeds 5 km average.
  }
  const dist = averageEndpointDistanceKm(candidate, existing);
  if (dist > MATCH_DISTANCE_KM) return false;
  return sim >= MATCH_JACCARD_MIN;
}

/**
 * Disambiguate a candidate's id against existing ids by appending -2, -3, ...
 * until unique. Stable: same input → same output.
 */
function uniqueId(baseId, takenIds) {
  if (!takenIds.has(baseId)) return baseId;
  let n = 2;
  while (takenIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

/**
 * Pure dedup function.
 *
 * @param {Array<{ id: string, name: string, startPoint: {lat:number,lon:number}, endPoint: {lat:number,lon:number} }>} existing
 * @param {Array<{ id: string, name: string, startPoint: {lat:number,lon:number}, endPoint: {lat:number,lon:number} }>} candidates
 * @returns {{ toAdd: any[], skippedDuplicates: Array<{ candidate: any, matchedExistingId: string, distanceKm: number, jaccard: number }> }}
 */
export function dedupePipelines(existing, candidates) {
  const taken = new Set(existing.map((p) => p.id));
  const toAdd = [];
  const skippedDuplicates = [];

  for (const cand of candidates) {
    // Compare against BOTH existing rows AND candidates already accepted
    // into toAdd. Without this, two GEM rows that match each other but
    // not anything in `existing` would both be added — duplicate-import
    // bug. Existing rows still win on cross-set match (they have richer
    // hand-curated evidence); within-toAdd matches retain the FIRST
    // accepted candidate (deterministic by candidate-list order).
    let matched = null;
    for (const ex of existing) {
      if (isDuplicate(cand, ex)) {
        matched = ex;
        break;
      }
    }
    if (!matched) {
      for (const earlier of toAdd) {
        if (isDuplicate(cand, earlier)) {
          matched = earlier;
          break;
        }
      }
    }
    if (matched) {
      skippedDuplicates.push({
        candidate: cand,
        matchedExistingId: matched.id,
        distanceKm: averageEndpointDistanceKm(cand, matched),
        jaccard: jaccard(cand.name, matched.name),
      });
      continue;
    }
    const finalId = uniqueId(cand.id, taken);
    taken.add(finalId);
    toAdd.push({ ...cand, id: finalId });
  }

  return { toAdd, skippedDuplicates };
}

// Internal exports for test coverage; not part of the public surface.
export const _internal = {
  haversineKm,
  averageEndpointDistanceKm,
  minPairwiseEndpointDistanceKm,
  tokenize,
  jaccard,
  isDuplicate,
  uniqueId,
  STOPWORDS,
  MATCH_DISTANCE_KM,
  MATCH_JACCARD_MIN,
  MATCH_NAME_IDENTICAL_DISTANCE_KM,
};
