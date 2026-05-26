/**
 * Pure clustering + entity-veto logic for the embedding dedup path.
 *
 * This module is intentionally pure and side-effect free:
 *   - No Redis.
 *   - No fetch.
 *   - No env lookups (orchestrator reads env and passes thresholds in).
 *
 * The orchestrator in brief-dedup.mjs wires these helpers to the
 * embedding client and the legacy Jaccard fallback.
 */

import { cosineSimilarity } from './brief-embedding.mjs';
import {
  COMMON_CAPITALIZED,
  LOCATION_GAZETTEER,
} from './entity-gazetteer.mjs';

// ── Entity extraction / veto ───────────────────────────────────────────

const CAPITALIZED_TOKEN_RE = /^[A-Z][a-zA-Z\-'.]{1,}$/;

// Longest multi-word entry in the gazetteer (e.g. "ho chi minh city"
// is 4 tokens). Precomputed once; the sliding window in
// extractEntities never tries phrases longer than this, so the cost
// stays O(N * MAX_PHRASE_LEN) rather than O(N²).
const MAX_LOCATION_PHRASE_LEN = (() => {
  let max = 1;
  for (const entry of LOCATION_GAZETTEER) {
    const len = entry.split(/\s+/).length;
    if (len > max) max = len;
  }
  return max;
})();

function cleanToken(t) {
  return t.replace(/[.,;:!?"')\]]+$/g, '').replace(/^["'([]+/g, '');
}

/**
 * Pull proper-noun-like entities from a headline and classify them
 * against the gazetteer.
 *
 * Locations are matched as **whole phrases** — single tokens like
 * "Tokyo" AND multi-token phrases like "Red Sea", "Strait of Hormuz",
 * "New York", "Abu Dhabi" all work. An earlier version tokenized on
 * whitespace and only checked single tokens, which silently made
 * ~30% of the gazetteer unreachable (bodies of water, regions,
 * compound city names). That turned off the veto for a whole class
 * of real headlines — hence the sliding-window greedy match below.
 *
 * Rules:
 *   1. Tokenize on whitespace, strip surrounding punctuation.
 *   2. Greedy match: at each position, try the longest multi-word
 *      location phrase first, down to 2 tokens. A phrase matches
 *      only when its first AND last tokens are capitalized (so
 *      "the middle east" in lowercase prose doesn't match, but
 *      "Middle East" in a headline does). Lowercase connectors
 *      like "of" / "and" may appear between them.
 *   3. If no multi-word match: fall back to single-token lookup.
 *      Capitalized + not in COMMON_CAPITALIZED → Location if in
 *      gazetteer, Actor otherwise.
 *
 * Sentence-start tokens are intentionally kept — news headlines
 * front-load the anchor entity ("Iran...", "Trump...").
 *
 * @param {string} title
 * @returns {{ locations: string[], actors: string[] }}
 */
export function extractEntities(title) {
  if (typeof title !== 'string' || title.length === 0) {
    return { locations: [], actors: [] };
  }
  const tokens = title.split(/\s+/).map(cleanToken).filter(Boolean);

  const locations = new Set();
  const actors = new Set();
  let i = 0;
  while (i < tokens.length) {
    // Greedy longest-phrase scan for multi-word locations.
    let matchedLen = 0;
    const maxTry = Math.min(MAX_LOCATION_PHRASE_LEN, tokens.length - i);
    for (let L = maxTry; L >= 2; L--) {
      const first = tokens[i];
      const last = tokens[i + L - 1];
      if (!CAPITALIZED_TOKEN_RE.test(first) || !CAPITALIZED_TOKEN_RE.test(last)) {
        continue;
      }
      const phrase = tokens.slice(i, i + L).join(' ').toLowerCase();
      if (LOCATION_GAZETTEER.has(phrase)) {
        locations.add(phrase);
        matchedLen = L;
        break;
      }
    }
    if (matchedLen > 0) {
      i += matchedLen;
      continue;
    }
    // Single-token classification.
    const tok = tokens[i];
    if (CAPITALIZED_TOKEN_RE.test(tok)) {
      const lower = tok.toLowerCase();
      if (!COMMON_CAPITALIZED.has(lower)) {
        if (LOCATION_GAZETTEER.has(lower)) {
          locations.add(lower);
        } else {
          actors.add(lower);
        }
      }
    }
    i += 1;
  }
  return {
    locations: [...locations],
    actors: [...actors],
  };
}

/**
 * Pairwise merge-veto.
 *
 * Fires when two titles share at least one location AND each side
 * has at least one actor the other doesn't — "same venue, different
 * protagonists" (canonical case: "Biden meets Xi in Tokyo" vs
 * "Biden meets Putin in Tokyo").
 *
 * Empty proper-noun sets on either side → defer to cosine (return false).
 *
 * @param {string} titleA
 * @param {string} titleB
 * @returns {boolean}
 */
export function shouldVeto(titleA, titleB) {
  const a = extractEntities(titleA);
  const b = extractEntities(titleB);

  if (a.actors.length === 0 && b.actors.length === 0) return false;

  const bLocSet = new Set(b.locations);
  const sharedLocation = a.locations.some((loc) => bLocSet.has(loc));
  if (!sharedLocation) return false;

  const aActorSet = new Set(a.actors);
  const bActorSet = new Set(b.actors);
  const aHasUnique = a.actors.some((act) => !bActorSet.has(act));
  const bHasUnique = b.actors.some((act) => !aActorSet.has(act));
  return aHasUnique && bHasUnique;
}

// ── Complete-link clustering ───────────────────────────────────────────

/**
 * Greedy first-fit complete-link clustering.
 *
 * Admission rule: a candidate joins an existing cluster ONLY IF, for
 * every member already in that cluster:
 *   1. cosine(candidate.embedding, member.embedding) >= cosineThreshold
 *   2. vetoFn(candidate, member) === false  (if vetoFn provided)
 *
 * Single-link would admit C into {A,B} as long as C~B clears the bar,
 * even if cosine(A,C) is low — the transitive chaining that re-
 * created the bridge-pollution failure mode on the Jaccard side. We
 * do NOT want that.
 *
 * Input items MUST be pre-sorted by the caller (the orchestrator in
 * brief-dedup.mjs sorts by [currentScore DESC, sha256(title) ASC]).
 * Changing input order changes cluster composition; the orchestrator
 * owns the determinism contract.
 *
 * @param {Array<{title:string, embedding:number[]}>} items
 * @param {object} opts
 * @param {number} opts.cosineThreshold
 * @param {((a: {title:string}, b: {title:string}) => boolean) | null} [opts.vetoFn]
 * @returns {{ clusters: number[][], vetoFires: number }}
 */
export function completeLinkCluster(items, { cosineThreshold, vetoFn = null }) {
  if (!Array.isArray(items)) {
    return { clusters: [], vetoFires: 0 };
  }

  const clusters = [];
  let vetoFires = 0;

  for (let i = 0; i < items.length; i++) {
    const candidate = items[i];
    if (!candidate || !Array.isArray(candidate.embedding)) {
      // Defensive: if an item somehow lacks an embedding, it goes in
      // its own cluster rather than poisoning the whole batch.
      clusters.push([i]);
      continue;
    }

    let joined = false;
    for (const cluster of clusters) {
      let admissible = true;
      for (const j of cluster) {
        const member = items[j];
        const cos = cosineSimilarity(candidate.embedding, member.embedding);
        if (cos < cosineThreshold) {
          admissible = false;
          break;
        }
        if (vetoFn?.(candidate, member)) {
          admissible = false;
          vetoFires += 1;
          break;
        }
      }
      if (admissible) {
        cluster.push(i);
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push([i]);
  }

  return { clusters, vetoFires };
}

// ── Single-link clustering ─────────────────────────────────────────────

/**
 * Single-link agglomerative clustering via union-find.
 *
 * Admission rule: two items end up in the same cluster iff there
 * EXISTS a path of pairwise merges, where every step has
 *   1. cosine(a.embedding, b.embedding) >= cosineThreshold
 *   2. vetoFn(a, b) === false  (if vetoFn provided)
 *
 * This lets wire stories chain through a strong intermediate
 * headline: ship-1 ↔ ship-5 (0.63) and ship-5 ↔ ship-8 (0.69) both
 * clear, so all three merge even when ship-1 ↔ ship-8 is only 0.50.
 * Complete-link would block this whole cluster because of the one
 * weak pair.
 *
 * The original plan rejected single-link to avoid "bridge pollution"
 * (topically-unrelated stories chaining through a mixed-topic
 * headline). With embeddings at threshold ≥ 0.60 the bridge has to
 * be semantically real, so the empirical win on the 2026-04-20
 * story set (F1 0.73 vs complete-link 0.53) outweighed the
 * theoretical concern.
 *
 * Output cluster membership is independent of iteration order — the
 * union-find shape is determined purely by the set of admissible
 * pairs, so single-link is permutation-invariant by construction.
 *
 * @param {Array<{title:string, embedding:number[]}>} items
 * @param {object} opts
 * @param {number} opts.cosineThreshold
 * @param {((a: {title:string}, b: {title:string}) => boolean) | null} [opts.vetoFn]
 * @returns {{ clusters: number[][], vetoFires: number }}
 */
export function singleLinkCluster(items, { cosineThreshold, vetoFn = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { clusters: [], vetoFires: 0 };
  }

  const n = items.length;
  const parent = new Array(n);
  const rank = new Array(n).fill(0);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  };

  let vetoFires = 0;
  for (let i = 0; i < n; i++) {
    const a = items[i];
    if (!a || !Array.isArray(a.embedding)) continue;
    for (let j = i + 1; j < n; j++) {
      const b = items[j];
      if (!b || !Array.isArray(b.embedding)) continue;
      // Already in the same cluster via a prior union — skip both
      // the cosine and veto checks. Union-find makes this cheap.
      if (find(i) === find(j)) continue;
      const cos = cosineSimilarity(a.embedding, b.embedding);
      if (cos < cosineThreshold) continue;
      if (vetoFn?.(a, b)) {
        vetoFires += 1;
        continue;
      }
      union(i, j);
    }
  }

  // Build clusters preserving the caller's input order: iterate
  // items in order, group by their union-find root, and drop into
  // a Map whose insertion order reflects first-appearance. Keeps
  // downstream representative selection deterministic alongside
  // the caller's pre-sort contract.
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }
  return { clusters: [...byRoot.values()], vetoFires };
}

