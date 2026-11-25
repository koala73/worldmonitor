import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

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
 * DUAL-VIEW lexical vectors; similarity = min of the two exact-feature
 * views' cosines (see lexicalStoryVector for why two views). Features:
 *   - word tokens            (weight 2.0)  — core lexical identity
 *   - word bigrams           (weight 1.5)  — order/direction ("ukraine
 *     drone" vs "russian drone" separates actor-flipped headlines that
 *     bag-of-words alone cannot)
 *   - char 4-grams per token (weight 1.0)  — morphology fuzz
 *     (iran/iranian, sanction/sanctions)
 *   - char bigrams for non-ASCII tokens — CJK and other unsegmented
 *     scripts get no whitespace tokens, so bigrams carry the signal
 * retained as sparse feature weights for collision-free identity scoring.
 * A 512-dimension projection uses HMAC-SHA256 when a deploy salt is set,
 * and historical FNV-1a otherwise. Projection noise never decides identity.
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
export const STORY_SIMILARITY_THRESHOLD = 0.604;

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

// Projection uses the full secret. The numeric fingerprint is diagnostic only.
const SIGN_SEED = 0x9e3779b9;
const encoder = new TextEncoder();

/** @param {unknown} value @returns {number} fingerprint, 0 when unset */
export function deriveFeatureHashSalt(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const digest = sha256(encoder.encode(value.trim()));
  return new DataView(digest.buffer, digest.byteOffset).getUint32(0);
}

let featureHashSalt;
let featureHashKey = null;

/** @param {string | null | undefined} value */
export function setFeatureHashSalt(value) {
  const salt = typeof value === 'string' ? value.trim() : '';
  featureHashKey = salt ? encoder.encode(salt) : null;
  featureHashSalt = deriveFeatureHashSalt(salt);
  return featureHashSalt;
}

/** Capture after worker loadEnvFile(), then keep the process setting stable. */
export function activeFeatureHashSalt() {
  if (featureHashSalt === undefined) setFeatureHashSalt(globalThis.process?.env?.STORY_FEATURE_HASH_SALT);
  return featureHashSalt;
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

// Connector words that survive the 3-char floor but carry no story
// identity (#4925 item 4). They are INDEX keys only: every headline shares
// "the"/"and"/"after", so their buckets hold the whole batch and either hit
// MAX_CANDIDATE_BUCKET (no pairs scored through them) or, below the cap,
// score every pair in the batch, which is the O(n²) scan the inverted index
// exists to avoid. The vector still sees these tokens; only candidate
// generation ignores them. Keyless headlines retain their original candidate
// tokens; the existing bucket cap still bounds pair scoring.
export const CANDIDATE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over',
  'after', 'amid', 'amidst', 'about', 'than', 'then', 'what', 'when', 'where',
  'while', 'who', 'why', 'how', 'its', 'his', 'her', 'their', 'our', 'your',
  'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'will', 'would',
  'could', 'should', 'can', 'may', 'might', 'must', 'does', 'did', 'not',
  'but', 'out', 'off', 'onto', 'via', 'per', 'says', 'said', 'say', 'new',
  'more', 'most', 'some', 'any', 'all', 'one', 'two', 'also', 'just', 'now',
  'here', 'there', 'they', 'them', 'you', 'she', 'him', 'these', 'those',
  'live', 'update', 'updates', 'latest', 'news', 'report', 'reports',
]);

/**
 * Tokens used for inverted-index candidate generation by clustering
 * callers (cheap pre-filter: only pairs sharing ≥1 token are scored).
 * ASCII tokens shorter than 3 chars and the CANDIDATE_STOPWORDS connector
 * words are dropped (stopword-weight noise); non-ASCII tokens are kept
 * whole AND as char bigrams so unsegmented scripts still produce index
 * keys. If none remain, retain the original keys under the same bucket cap.
 * @param {string} text
 * @returns {{ primary: Set<string>; fallback: Set<string> }}
 */
function candidateTokenSets(text) {
  const out = new Set();
  const fallback = new Set();
  const clamped = stripAttributionSuffix(text).slice(0, MAX_IDENTITY_CHARS);
  for (const tok of normalizeStoryText(clamped).split(' ')) {
    if (!tok) continue;
    if (isNonAscii(tok)) {
      out.add(tok);
      for (let i = 0; i + 2 <= tok.length; i++) out.add(tok.slice(i, i + 2));
    } else if (tok.length >= 3) {
      fallback.add(tok);
      if (!CANDIDATE_STOPWORDS.has(tok)) {
        out.add(tok);
        if (tok.length > 4 && tok.endsWith('s')) out.add(tok.slice(0, -1));
      }
    }
  }
  return { primary: out, fallback };
}

export function candidateTokens(text) {
  const { primary, fallback } = candidateTokenSets(text);
  return primary.size ? primary : fallback;
}

// Trailing source-attribution suffixes ("… - Reuters", "… - example.com")
// must not enter the vector: Google-News wrapper titles carry them on
// EVERY item, so the publisher token (capitalized → entity-boosted ×3)
// adds shared mass across DISTINCT same-publisher stories and pulls them
// toward a false merge (cross-model review finding, PR #4924). Mirrors
// list-feed-digest's normalizeTitle suffix rules, but case-preserving.
const ATTRIBUTION_PUBLISHERS = [
  'reuters',
  'ap news',
  'bbc',
  'cnn',
  'al jazeera',
  'france 24',
  'dw news',
  'pbs newshour',
  'cbs news',
  'nbc',
  'abc',
  'associated press',
  'the guardian',
  'nos nieuws',
  'tagesschau',
  'cnbc',
  'the national',
];
const ATTRIBUTION_PUBLISHER_SET = new Set(ATTRIBUTION_PUBLISHERS);
const MAX_PUBLISHER_LABEL = Math.max(...ATTRIBUTION_PUBLISHERS.map((name) => name.length));
const MAX_DOMAIN_LABEL = 160;

function isAttributionSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11
    || code === 0xa0 || code === 0x1680 || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
    || (code >= 0x2000 && code <= 0x200a);
}

function isDomainLabelChar(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 95
    || code === 46
    || isAttributionSpace(code);
}

function trimAttributionSpace(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isAttributionSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isAttributionSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

function isDomainAttribution(label) {
  if (label.length === 0 || label.length > MAX_DOMAIN_LABEL) return false;
  const lower = label.toLowerCase();
  const tld = lower.endsWith('.co.uk') ? '.co.uk'
    : lower.endsWith('.com') ? '.com'
    : lower.endsWith('.org') ? '.org'
    : lower.endsWith('.net') ? '.net'
    : '';
  if (!tld) return false;
  const name = label.slice(0, label.length - tld.length);
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i += 1) {
    if (!isDomainLabelChar(name.charCodeAt(i))) return false;
  }
  return true;
}

function isPublisherAttribution(label) {
  return label.length > 0
    && label.length <= MAX_PUBLISHER_LABEL
    && ATTRIBUTION_PUBLISHER_SET.has(label.toLowerCase());
}

function stripOneAttribution(text, kind, allowPipe) {
  let sep = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === '-' || c === '\u2013' || c === '\u2014' || c === '|') {
      sep = i;
      break;
    }
  }
  if (sep < 0) return text;
  if (text[sep] === '|' && !allowPipe) return text;
  const label = trimAttributionSpace(text.slice(sep + 1));
  const matched = kind === 'domain' ? isDomainAttribution(label) : isPublisherAttribution(label);
  if (!matched) return text;
  let cut = sep;
  while (cut > 0 && isAttributionSpace(text.charCodeAt(cut - 1))) cut -= 1;
  return text.slice(0, cut);
}

// Unbounded feed titles feed char-4gram loops inside a 25s serverless
// budget; clamp AFTER suffix stripping. 300 chars ≈ 3× a long headline.
const MAX_IDENTITY_CHARS = 300;

export function stripAttributionSuffix(text, options) {
  const allowPipe = !options || options.allowPipe !== false;
  let out = text || '';
  out = stripOneAttribution(out, 'domain', allowPipe);
  out = stripOneAttribution(out, 'publisher', allowPipe);
  return out;
}

/**
 * Content tokens WITH the discriminative flags read from the raw
 * (pre-lowercase) text. Callers should pass raw titles — lowercasing
 * upstream destroys the entity signal (harmless, but the boost is lost).
 * @param {string} text
 * @returns {Array<{ tok: string; boost: number; entity: boolean }>}
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
    kept.push({ tok, boost, entity: capitalized && !hasDigit && !CANDIDATE_STOPWORDS.has(tok) });
  }
  return kept;
}

/** @param {Float64Array} vec @param {Map<string, number>} features @param {string} feature @param {number} weight */
function addFeature(vec, features, feature, weight) {
  features.set(feature, (features.get(feature) || 0) + weight);
  let idx;
  let sign;
  if (featureHashKey) {
    const digest = hmac(sha256, featureHashKey, encoder.encode(feature));
    idx = ((digest[0] << 8) | digest[1]) % DIM;
    sign = (digest[2] & 1) === 1 ? 1 : -1;
  } else {
    idx = fnv1a(feature, 0) % DIM;
    sign = (fnv1a(feature, SIGN_SEED) & 1) === 1 ? 1 : -1;
  }
  vec[idx] += sign * weight;
}

/** @param {Map<string, number>} features */
function normalizeFeatures(features) {
  let norm = 0;
  for (const value of features.values()) norm += value * value;
  norm = Math.sqrt(norm);
  for (const [key, value] of features) features.set(key, value / norm);
  return features;
}

/** @param {Float64Array} vec */
function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
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
 * tests/story-identity.test.mjs: min positive 0.619, max negative
 * 0.589 with THRESHOLD 0.604 between them.
 *
 * Returns null for texts with no usable tokens (callers treat null as
 * "cannot match" — never same-story).
 * @param {string} text
 * @returns {{ u: Float64Array; b: Float64Array } | null}
 */
function lexicalStoryVector(text) {
  const tokens = contentTokens(text);
  if (tokens.length === 0) return null;
  activeFeatureHashSalt();
  const fu = new Map();
  const fb = new Map();
  const u = new Float64Array(DIM);
  const b = new Float64Array(DIM);
  for (let i = 0; i < tokens.length; i++) {
    const { tok, boost } = tokens[i];
    addFeature(u, fu, `w:${tok}`, WEIGHT_TOKEN);
    addFeature(b, fb, `w:${tok}`, WEIGHT_TOKEN * boost);
    if (i + 1 < tokens.length) {
      const bigram = `b:${tok} ${tokens[i + 1].tok}`;
      addFeature(u, fu, bigram, WEIGHT_BIGRAM);
      addFeature(b, fb, bigram, WEIGHT_BIGRAM);
    }
    if (isNonAscii(tok)) {
      // Unsegmented-script fallback: char bigrams of the raw token.
      for (let j = 0; j + 2 <= tok.length; j++) {
        const g = `c2:${tok.slice(j, j + 2)}`;
        addFeature(u, fu, g, WEIGHT_CHARGRAM);
        addFeature(b, fb, g, WEIGHT_CHARGRAM);
      }
    }
    if (tok.length >= 4) {
      const padded = `<${tok}>`;
      for (let j = 0; j + 4 <= padded.length; j++) {
        const g = `c4:${padded.slice(j, j + 4)}`;
        addFeature(u, fu, g, WEIGHT_CHARGRAM);
        addFeature(b, fb, g, WEIGHT_CHARGRAM);
      }
    }
  }
  const un = l2normalize(u);
  const bn = l2normalize(b);
  // Token set rides along for the containment rescue in
  // cosineSimilarity — severe RSS truncation (a headline cut to ~40% of
  // its tokens) drops the cosine below threshold even though the short
  // form is a strict subset of the long form. The old word-overlap
  // dedup metric (|∩|/min) handled exactly this class; keep that
  // guarantee via token containment.
  return { u: un, b: bn, t: new Set(tokens.map((entry) => entry.tok)),
    e: foldEntityVariants(tokens.filter((entry) => entry.entity).map((entry) => entry.tok)),
    f: { u: normalizeFeatures(fu), b: normalizeFeatures(fb) } };
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

/** @param {Map<string, number>} a @param {Map<string, number>} b */
function featureDot(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [key, value] of small) sum += value * (large.get(key) || 0);
  return sum;
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

// Same-parties rescue: reworded wire reports of one event ("Australia,
// Solomon Islands sign security pact in blow to China" vs "Solomon
// Islands ends controversial security pact with China for Australian
// treaty") share few words but name the same parties. When one title's
// ≥4 entity tokens all appear in the other, they share ≥2 non-entity
// topic words, and the cosine is already moderate, they are the same
// story. Entity tokens match by prefix, so "Australian" and "Australia’s"
// match "Australia".
const SAME_PARTIES_MIN_ENTITIES = 4;
const SAME_PARTIES_SCORE_FLOOR = 0.43;
const SAME_PARTIES_MIN_TOPIC_TOKENS = 2;

/** @param {string} x @param {string} y */
function isEntityVariant(x, y) {
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
}

/**
 * One token per party, so "Iran" and "Iranian" in one title count once.
 * @param {string[]} toks
 */
function foldEntityVariants(toks) {
  const kept = [];
  for (const tok of [...new Set(toks)].sort((x, y) => x.length - y.length)) {
    if (!kept.some((other) => isEntityVariant(tok, other))) kept.push(tok);
  }
  return new Set(kept);
}

/** @param {Set<string>} from @param {Set<string>} to */
function entitiesCovered(from, to) {
  for (const tok of from) {
    if (![...to].some((other) => isEntityVariant(tok, other))) return false;
  }
  return true;
}

/** @param {{ t: Set<string>; e: Set<string> }} a @param {{ t: Set<string>; e: Set<string> }} b */
function sameParties(a, b) {
  if (Math.min(a.e.size, b.e.size) < SAME_PARTIES_MIN_ENTITIES) return false;
  const aCovered = a.e.size <= b.e.size && entitiesCovered(a.e, b.e);
  if (!aCovered && !(b.e.size <= a.e.size && entitiesCovered(b.e, a.e))) return false;
  let sharedTopicTokens = 0;
  for (const tok of a.t) {
    if (b.t.has(tok) && !a.e.has(tok) && !b.e.has(tok) && !CANDIDATE_STOPWORDS.has(tok)) sharedTopicTokens++;
  }
  return sharedTopicTokens >= SAME_PARTIES_MIN_TOPIC_TOKENS;
}

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  // Exact lexical features prevent hash collisions and salt changes from
  // changing identity. External embedding providers keep dense cosine.
  const score = a.f && b.f
    ? Math.min(featureDot(a.f.u, b.f.u), featureDot(a.f.b, b.f.b))
    : Math.min(dot(a.u, b.u), dot(a.b, b.b));
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
  if (score < STORY_SIMILARITY_THRESHOLD && score >= SAME_PARTIES_SCORE_FLOOR && a.e && b.e && sameParties(a, b)) {
    return STORY_SIMILARITY_THRESHOLD;
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
  const tokenViews = texts.map((t) => candidateTokenSets(t));
  const tokenSets = tokenViews.map(({ primary, fallback }) => primary.size ? primary : fallback);
  const needsFallback = tokenViews.some(({ primary }) => primary.size === 0);

  // Exact-duplicate pre-union (#4924 external review): identical
  // normalized texts union unconditionally BEFORE the candidate scan.
  // Without this, a mega-story (e.g. 251 verbatim syndications) makes
  // every shared token bucket exceed MAX_CANDIDATE_BUCKET, no pairs get
  // scored, and the most-corroborated story of the day degrades to
  // singletons — the exact case corroboration exists for.
  const byExactText = new Map();

  const invertedIndex = new Map();
  const fallbackIndex = new Map();
  for (let i = 0; i < texts.length; i++) {
    for (const token of tokenSets[i]) {
      const bucket = invertedIndex.get(token);
      if (bucket) bucket.push(i);
      else invertedIndex.set(token, [i]);
    }
    if (needsFallback) {
      for (const token of tokenViews[i].fallback) {
        const bucket = fallbackIndex.get(token);
        if (bucket) bucket.push(i);
        else fallbackIndex.set(token, [i]);
      }
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
    if (tokenViews[i].primary.size === 0) {
      for (const token of tokenViews[i].fallback) {
        const bucket = fallbackIndex.get(token);
        if (!bucket || bucket.length > MAX_CANDIDATE_BUCKET) continue;
        for (const idx of bucket) {
          if (idx !== i) candidates.add(idx);
        }
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

// Delivery and cross-build coverage must agree on punctuation and attribution.
const NORMALIZED_TITLE_SCAN = 2_000;
// Question marks across scripts, Greek ';' (U+037E) included. A false match
// only gives a headline its own label; a miss merges a question into the report.
const CLASSIFY_QUESTION_RE = /[\u003F\u003B\u037E\u055E\u061F\u0705\u1367\u203D\u2047\u2048\u2049\u2753\u2E2E\uA60F\uFE16\uFE56\uFF1F][^\p{L}\p{N}]*(?:[-–—|][^?\u061F\uFF1F]*)?$/u;
// U.S. and U.K. are one word, as US and UK are.
const DOTTED_ABBREVIATION_RE = /(?<![\p{L}\p{N}])(?:\p{L}\.){2,}/gu;
// Anything between letters that is not a letter, number, space or apostrophe
// is a word break (re-sign, re\u00adsign, re/sign are not resign). Enumerating
// separators always misses one; an apostrophe stays inside its word (UAE's).
const IN_WORD_HYPHEN_RE = /(?<=[\p{L}\p{N}])[^\p{L}\p{N}\s'\u2018\u2019\u02BC]+(?=[\p{L}\p{N}])/gu;
// A credit is a bare outlet host: name.tld, www.name.tld, or name under a
// country second level (bbc.co.uk). Any other dotted or underscored run
// (mines.confirmed.com) is headline text.
const BARE_HOST_RE = /^(?:www\.)?[\p{L}\p{N}-]+\.(?:(?:co|com|net|org|gov|ac|edu)\.[a-z]{2}|[\p{L}\p{N}-]+)$/u;

/**
 * The title without its outlet credits, or null when a stripped credit is not
 * a bare host (a clause ending in a domain) or the chain is too long to check.
 * Credits come off one at a time, as normalizeNewsStoryTitle strips them.
 * @param {string} lower
 */
function stripOutletCredits(lower) {
  let rest = lower;
  for (let i = 0; ; i += 1) {
    const domainless = stripOneAttribution(rest, 'domain', false);
    const credit = rest.slice(domainless.length).trim().replace(/^[-–—|]\s*/, '');
    if (credit && !BARE_HOST_RE.test(credit)) return null;
    const next = stripOneAttribution(domainless, 'publisher', false);
    if (next === rest) return rest;
    if (i === 8) return null;
    rest = next;
  }
}

/**
 * The identity the AI classify cache keys a headline on (#10976): its story,
 * so outlet suffixes, case and punctuation share one label. The exact title
 * is kept when sharing could hand one headline's label to different text:
 * under four words (no story key), or a stripped credit that is not a bare
 * host (several words, or clause words joined by dots or underscores). A
 * question in any script keeps its own label, anything but an apostrophe
 * between letters splits words (re-sign, resign), and a headline that still
 * carries combining marks keeps its exact title.
 * @param {string} title
 */
export function classifyCacheIdentity(title) {
  if (typeof title !== 'string') return '';
  // NFC first: a decomposed accent is the precomposed letter. Marks that
  // remain are vowels or meaning in Arabic, Hebrew and Indic scripts, which
  // the story normalizer deletes, so such a headline keeps its exact title.
  const lower = title.normalize('NFC').toLowerCase();
  if (/\p{M}/u.test(lower)) return lower;
  const rest = stripOutletCredits(lower);
  if (rest === null) return lower;
  // Past the story scan the key is a prefix and the question test reads the
  // tail, so a padded question would take the report's label: keep the title.
  if (rest.length > NORMALIZED_TITLE_SCAN) return lower;
  // Split in-word dashes after the credits are gone, so "Hormuz—Reuters" still strips.
  const words = rest.replace(DOTTED_ABBREVIATION_RE, (run) => run.replaceAll('.', ''));
  const story = normalizeNewsStoryTitle(words.replace(IN_WORD_HYPHEN_RE, ' '));
  if (story.split(' ').length < 4) return lower;
  // The question test reads the same credit-stripped text the key does, bounded
  // above, so stripped whitespace cannot move the '?' out of its window.
  return story + (CLASSIFY_QUESTION_RE.test(rest) ? ' ?' : '');
}

export function normalizeNewsStoryTitle(title) {
  if (typeof title !== 'string') return '';
  const stripped = stripAttributionSuffix(title.toLowerCase(), { allowPipe: false });
  const bounded = stripped.length > NORMALIZED_TITLE_SCAN ? stripped.slice(0, NORMALIZED_TITLE_SCAN) : stripped;
  return bounded
    // Story tracking drops all punctuation, which makes "1.5 million" and
    // "15 million" one headline. Held for a day, that would silence the
    // second, so punctuation inside a number becomes a space instead.
    .replace(/(?<=\p{N})[^\p{L}\p{N}\s]+(?=\p{N})/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const NEWS_PUBLISHER_COVERAGE_PREFIX = 'news:publisher-coverage:v2:';

// One key per headline across editions (#10977): a publisher family carrying
// the story in any edition corroborates it in every edition.
export function newsPublisherCoverageKey(title) {
  if (typeof title !== 'string' || !title) return '';
  const normalized = normalizeNewsStoryTitle(title);
  // Short or unsegmented headlines use the literal identity, like the relay,
  // and so does one whose stripped credit is a clause, not an outlet: that
  // wording must not take another headline's publisher count.
  const identity = normalized.split(' ').length >= 4 && stripOutletCredits(title.toLowerCase()) !== null ? normalized : title;
  return `${NEWS_PUBLISHER_COVERAGE_PREFIX}${bytesToHex(sha256(encoder.encode(identity)))}`;
}
