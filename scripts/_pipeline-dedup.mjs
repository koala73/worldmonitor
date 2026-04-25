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
 * Decide if a candidate matches an existing row. Both criteria required.
 */
function isDuplicate(candidate, existing) {
  const dist = averageEndpointDistanceKm(candidate, existing);
  if (dist > MATCH_DISTANCE_KM) return false;
  const sim = jaccard(candidate.name, existing.name);
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
  tokenize,
  jaccard,
  isDuplicate,
  uniqueId,
  STOPWORDS,
  MATCH_DISTANCE_KM,
  MATCH_JACCARD_MIN,
};
