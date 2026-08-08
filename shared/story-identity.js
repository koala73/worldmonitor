/**
 * story-identity — the ONE similarity definition for "are these the same
 * news story?" (#4919, Bet 1 of the 2026-07-05 strategic review).
 *
 * Before this module the codebase answered that question three different
 * ways: scripts/_clustering.mjs (title-token Jaccard ≥ 0.5),
 * server/worldmonitor/news/v1/dedup.mjs (word-overlap > 0.6 of the smaller
 * set), and list-feed-digest.ts story tracking (EXACT sha256 of the
 * normalized title — so any wording edit forked the story and deflated
 * corroboration). All three now delegate here.
 *
 * ── Method ──────────────────────────────────────────────────────────────
 * DUAL-VIEW feature-hashed lexical vectors; similarity = min of the two
 * views' cosines (see lexicalStoryVector for why two views). Features:
 *   - word tokens            (weight 2.0)  — core lexical identity
 *   - word bigrams           (weight 1.5)  — order/direction ("ukraine
 *     drone" vs "russian drone" separates actor-flipped headlines that
 *     bag-of-words alone cannot)
 *   - char 4-grams per token (weight 1.0)  — morphology fuzz
 *     (iran/iranian, sanction/sanctions)
 *   - char bigrams for non-ASCII tokens — CJK and other unsegmented
 *     scripts get no whitespace tokens, so bigrams carry the signal
 * hashed (signed FNV-1a) into 512 dims and L2-normalized. Deterministic,
 * dependency-free, script-agnostic, ~µs per title.
 *
 * This is an EDIT-TOLERANT identity, not a semantic one: it merges the
 * real-world corroboration killers (source suffixes, truncations,
 * qualifier edits, reorders, morphology) and keeps distinct events apart.
 * It can NOT merge a full cross-language paraphrase ("Iran threatens…" /
 * "Teherán amenaza…") — that requires a semantic embedding provider,
 * which plugs in behind `setStoryVectorProvider()` without touching any
 * consumer. Known hard limit either way: two events differing by one
 * token ("12th sanctions package" vs "13th sanctions package") are not
 * separable by similarity alone; the 96h ingest window bounds the damage.
 *
 * Mirrored byte-for-byte to scripts/shared/story-identity.js (enforced by
 * tests/scripts-shared-mirror.test.mjs — Railway seed bundles deploy with
 * rootDirectory=scripts and cannot see repo-root shared/).
 */

const DIM = 512;

// Tuned on the labeled pair set in tests/story-identity.test.mjs
// (edit-variant positives vs same-topic-different-event negatives). The
// test asserts full separation with margin on both sides; retune there
// if the vectorizer changes.
export const STORY_SIMILARITY_THRESHOLD = 0.615;

const WEIGHT_TOKEN = 2.0;
const WEIGHT_BIGRAM = 1.5;
const WEIGHT_CHARGRAM = 1.0;
// Discriminative boosts, applied to the token feature only (bigrams keep
// their flat weight — they already encode order). Without these, a
// one-entity swap ("Turkey hikes rates to 50%" vs "Argentina hikes rates
// to 50%") scores ~0.82 because the shared verb/number mass dominates;
// capitalized-in-raw-text tokens are entity-shaped and numbers are
// event parameters (magnitudes, percentages, ordinals), so both carry
// the discriminating signal. In Title Case or ALL-CAPS headlines every
// token gets the boost — uniform scaling, which cosine ignores — so the
// heuristic only sharpens sentence-case headlines and never hurts.
const BOOST_ENTITY = 3.0;
const BOOST_NUMBER = 2.0;

/** FNV-1a 32-bit over a string, with a seed so we can derive two
 * independent hashes (index + sign) from one feature. */
function fnv1a(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Generic story-text normalization: lowercase, strip everything that is
 * not a Unicode letter/number, collapse whitespace. Callers that know
 * about source-attribution suffixes ("… - Reuters") strip those BEFORE
 * calling (list-feed-digest's normalizeTitle already does).
 * @param {string} text
 * @returns {string}
 */
export function normalizeStoryText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} token */
function isNonAscii(token) {
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) > 127) return true;
  }
  return false;
}

/**
 * Tokens used for inverted-index candidate generation by clustering
 * callers (cheap pre-filter: only pairs sharing ≥1 token are scored).
 * ASCII tokens shorter than 3 chars are dropped (stopword-weight noise);
 * non-ASCII tokens are kept whole AND as char bigrams so unsegmented
 * scripts still produce index keys.
 * @param {string} text
 * @returns {Set<string>}
 */
export function candidateTokens(text) {
  const out = new Set();
  const clamped = stripAttributionSuffix(text).slice(0, MAX_IDENTITY_CHARS);
  for (const tok of normalizeStoryText(clamped).split(' ')) {
    if (!tok) continue;
    if (isNonAscii(tok)) {
      out.add(tok);
      for (let i = 0; i + 2 <= tok.length; i++) out.add(tok.slice(i, i + 2));
    } else if (tok.length >= 3) {
      out.add(tok);
    }
  }
  return out;
}

// Trailing source-attribution suffixes ("… - Reuters", "… - example.com")
// must not enter the vector: Google-News wrapper titles carry them on
// EVERY item, so the publisher token (capitalized → entity-boosted ×3)
// adds shared mass across DISTINCT same-publisher stories and pulls them
// toward a false merge (cross-model review finding, PR #4924). Mirrors
// list-feed-digest's normalizeTitle suffix rules, but case-preserving.
const ATTRIBUTION_SUFFIX_RES = [
  /\s*[-\u2013\u2014|]\s*[\w\s.]+\.(?:com|org|net|co\.uk)\s*$/i,
  /\s*[-\u2013\u2014|]\s*(?:reuters|ap news|bbc|cnn|al jazeera|france 24|dw news|pbs newshour|cbs news|nbc|abc|associated press|the guardian|nos nieuws|tagesschau|cnbc|the national)\s*$/i,
];

// Unbounded feed titles feed char-4gram loops inside a 25s serverless
// budget; clamp AFTER suffix stripping. 300 chars ≈ 3× a long headline.
const MAX_IDENTITY_CHARS = 300;

/** @param {string} text @returns {string} */
export function stripAttributionSuffix(text) {
  let out = text || '';
  for (const re of ATTRIBUTION_SUFFIX_RES) out = out.replace(re, '');
  return out;
}

/**
 * Content tokens WITH the discriminative flags read from the raw
 * (pre-lowercase) text. Callers should pass raw titles — lowercasing
 * upstream destroys the entity signal (harmless, but the boost is lost).
 * @param {string} text
 * @returns {Array<{ tok: string; boost: number }>}
 */
function contentTokens(text) {
  const kept = [];
  const clamped = stripAttributionSuffix(text).slice(0, MAX_IDENTITY_CHARS);
  for (const raw of clamped.split(/\s+/)) {
    // Strip everything that is not a Unicode letter/number, keeping the
    // original case so the entity heuristic can read it.
    const clean = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (!clean) continue;
    const tok = clean.toLowerCase();
    if (!isNonAscii(tok) && tok.length < 3) continue;
    const capitalized = /^\p{Lu}/u.test(clean);
    const hasDigit = /\p{N}/u.test(clean);
    const boost = hasDigit ? BOOST_NUMBER : capitalized ? BOOST_ENTITY : 1;
    kept.push({ tok, boost });
  }
  return kept;
}

/** @param {Float64Array} vec @param {string} feature @param {number} weight */
function addFeature(vec, feature, weight) {
  const idx = fnv1a(feature, 0) % DIM;
  const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 1 ? 1 : -1;
  vec[idx] += sign * weight;
}

/** @param {Float64Array} vec */
function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

/**
 * The default lexical vectorizer — DUAL VIEW. Returns two L2-normalized
 * 512-dim views of the same text:
 *   - `u` (uniform): every token feature at flat weight. Sensitive to
 *     action/verb substitutions ("seizes tanker" vs "threatens to
 *     close") that entity weighting would wash out.
 *   - `b` (boosted): entity-shaped (capitalized-in-raw) tokens ×3 and
 *     numeric tokens ×2. Sensitive to one-entity swaps ("Turkey hikes
 *     rates…" vs "Argentina hikes rates…") that flat weighting scores
 *     ~0.82 because the shared verb mass dominates.
 * A pair is the same story only when BOTH views agree (similarity =
 * min of the two cosines) — each view catches the failure mode the
 * other is blind to. Tuned on the labeled pair set in
 * tests/story-identity.test.mjs: min positive 0.634, max negative
 * 0.595 with THRESHOLD 0.615 between them.
 *
 * Returns null for texts with no usable tokens (callers treat null as
 * "cannot match" — never same-story).
 * @param {string} text
 * @returns {{ u: Float64Array; b: Float64Array } | null}
 */
function lexicalStoryVector(text) {
  const tokens = contentTokens(text);
  if (tokens.length === 0) return null;
  const u = new Float64Array(DIM);
  const b = new Float64Array(DIM);
  for (let i = 0; i < tokens.length; i++) {
    const { tok, boost } = tokens[i];
    addFeature(u, `w:${tok}`, WEIGHT_TOKEN);
    addFeature(b, `w:${tok}`, WEIGHT_TOKEN * boost);
    if (i + 1 < tokens.length) {
      const bigram = `b:${tok} ${tokens[i + 1].tok}`;
      addFeature(u, bigram, WEIGHT_BIGRAM);
      addFeature(b, bigram, WEIGHT_BIGRAM);
    }
    if (isNonAscii(tok)) {
      // Unsegmented-script fallback: char bigrams of the raw token.
      for (let j = 0; j + 2 <= tok.length; j++) {
        const g = `c2:${tok.slice(j, j + 2)}`;
        addFeature(u, g, WEIGHT_CHARGRAM);
        addFeature(b, g, WEIGHT_CHARGRAM);
      }
    }
    if (tok.length >= 4) {
      const padded = `<${tok}>`;
      for (let j = 0; j + 4 <= padded.length; j++) {
        const g = `c4:${padded.slice(j, j + 4)}`;
        addFeature(u, g, WEIGHT_CHARGRAM);
        addFeature(b, g, WEIGHT_CHARGRAM);
      }
    }
  }
  const un = l2normalize(u);
  const bn = l2normalize(b);
  if (!un || !bn) return null;
  // Token set rides along for the containment rescue in
  // cosineSimilarity — severe RSS truncation (a headline cut to ~40% of
  // its tokens) drops the cosine below threshold even though the short
  // form is a strict subset of the long form. The old word-overlap
  // dedup metric (|∩|/min) handled exactly this class; keep that
  // guarantee via token containment.
  return { u: un, b: bn, t: new Set(tokens.map((entry) => entry.tok)) };
}

/** Active vectorizer — swappable for a semantic embedding provider. */
let activeVectorizer = lexicalStoryVector;

/**
 * Plug in a semantic embedding provider (must be synchronous or the
 * caller precomputes; must return `{ u, b }` of L2-normalized
 * Float64Arrays of a consistent dimension — a single-embedding provider
 * sets u === b — or null). Pass null to restore the default lexical
 * vectorizer. Consumers never change — only the vector source.
 * @param {((text: string) => { u: Float64Array; b: Float64Array } | null) | null} provider
 */
export function setStoryVectorProvider(provider) {
  activeVectorizer = typeof provider === 'function' ? provider : lexicalStoryVector;
}

/**
 * @param {string} text
 * @returns {{ u: Float64Array; b: Float64Array } | null} dual-view story
 *   vector (opaque — pass to cosineSimilarity), or null when the text
 *   has no usable signal.
 */
export function storyVector(text) {
  return activeVectorizer(text);
}

/** @param {Float64Array} a @param {Float64Array} b */
function dot(a, b) {
  if (a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/**
 * Similarity of two dual-view story vectors: the MIN of the uniform-view
 * and boosted-view cosines — a pair is the same story only when both
 * views agree. Null vectors never match anything.
 * @param {{ u: Float64Array; b: Float64Array } | null} a
 * @param {{ u: Float64Array; b: Float64Array } | null} b
 * @returns {number}
 */
// Containment rescue floor: a title whose content tokens are ≥90%
// contained in the other's (with at least 4 tokens on the smaller side,
// so fragments like "Iran" can't rescue) IS the same story — the
// truncated-wire-copy class the old |∩|/min dedup metric guaranteed.
const CONTAINMENT_RESCUE_MIN_TOKENS = 4;
const CONTAINMENT_RESCUE_RATIO = 0.9;
const CONTAINMENT_RESCUE_SCORE = 0.9;

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const score = Math.min(dot(a.u, b.u), dot(a.b, b.b));
  // Rescue only applies to lexical vectors carrying token sets — a
  // semantic provider's vectors skip it (semantic cosine already
  // handles truncation).
  if (score < CONTAINMENT_RESCUE_SCORE && a.t && b.t) {
    const [small, large] = a.t.size <= b.t.size ? [a.t, b.t] : [b.t, a.t];
    if (small.size >= CONTAINMENT_RESCUE_MIN_TOKENS) {
      let shared = 0;
      for (const tok of small) {
        if (large.has(tok)) shared++;
      }
      if (shared / small.size >= CONTAINMENT_RESCUE_RATIO) {
        return CONTAINMENT_RESCUE_SCORE;
      }
    }
  }
  return score;
}

/**
 * Convenience: similarity of two raw texts.
 * @param {string} textA @param {string} textB
 * @returns {number}
 */
export function storySimilarity(textA, textB) {
  return cosineSimilarity(storyVector(textA), storyVector(textB));
}

/**
 * @param {string} textA @param {string} textB
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isSameStory(textA, textB, threshold = STORY_SIMILARITY_THRESHOLD) {
  return storySimilarity(textA, textB) >= threshold;
}

// A token shared by more than this many titles carries no clustering
// signal (it is the batch's "the") but drives O(bucket²) pair scoring —
// an adversarial or organic hot-entity spike (thousands of titles naming
// one entity) would otherwise burn seconds of CPU inside the digest
// handler's 25s budget. Pairs joined ONLY by ultra-hot tokens almost
// always share a rarer token too.
const MAX_CANDIDATE_BUCKET = 250;

/**
 * Cluster texts into same-story groups: connected components over the
 * "similarity ≥ threshold" edge set (union-find), with inverted-index
 * candidate generation so only pairs sharing ≥1 token are scored.
 *
 * Connected components — NOT the greedy first-seed pass the legacy
 * _clustering.mjs used — because component membership is independent of
 * input order: feed arrival order varies run to run, and under greedy
 * assignment a chain (A~B, B~C, A≁C) could land C in or out of A's
 * cluster depending on which seeded first, churning the canonical
 * story:track identity downstream (cross-model review finding,
 * PR #4924). Transitive chains merge by design; the threshold's
 * precision bounds chain length in practice.
 * @param {string[]} texts
 * @param {{ threshold?: number }} [opts]
 * @returns {number[][]} clusters of indices into `texts`, ordered by
 *   smallest member index; members ascending
 */
export function clusterTexts(texts, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : STORY_SIMILARITY_THRESHOLD;
  const vectors = texts.map((t) => storyVector(t));
  const tokenSets = texts.map((t) => candidateTokens(t));

  // Exact-duplicate pre-union (#4924 external review): identical
  // normalized texts union unconditionally BEFORE the candidate scan.
  // Without this, a mega-story (e.g. 251 verbatim syndications) makes
  // every shared token bucket exceed MAX_CANDIDATE_BUCKET, no pairs get
  // scored, and the most-corroborated story of the day degrades to
  // singletons — the exact case corroboration exists for.
  const byExactText = new Map();

  const invertedIndex = new Map();
  for (let i = 0; i < texts.length; i++) {
    for (const token of tokenSets[i]) {
      const bucket = invertedIndex.get(token);
      if (bucket) bucket.push(i);
      else invertedIndex.set(token, [i]);
    }
  }

  const parent = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) parent[i] = i;

  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Deterministic: smaller index becomes the root.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (let i = 0; i < texts.length; i++) {
    const normalized = normalizeStoryText(texts[i]);
    if (!normalized) continue;
    const first = byExactText.get(normalized);
    if (first === undefined) byExactText.set(normalized, i);
    else union(first, i);
  }

  for (let i = 0; i < texts.length; i++) {
    if (!vectors[i]) continue;
    const candidates = new Set();
    for (const token of tokenSets[i]) {
      const bucket = invertedIndex.get(token);
      if (!bucket || bucket.length > MAX_CANDIDATE_BUCKET) continue;
      for (const idx of bucket) {
        if (idx > i) candidates.add(idx);
      }
    }
    for (const j of candidates) {
      if (find(i) === find(j)) continue;
      if (cosineSimilarity(vectors[i], vectors[j]) >= threshold) union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < texts.length; i++) {
    const root = find(i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }
  return Array.from(byRoot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, members]) => members);
}
