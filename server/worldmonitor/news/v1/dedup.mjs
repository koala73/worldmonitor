/**
 * Headline dedup + story-identity assignment for the news pipeline.
 * Plain JS module so it can be imported from both TS source and .mjs tests.
 *
 * #4919: similarity is delegated to shared/story-identity.js — the single
 * "same news story?" definition (previously this file carried its own
 * word-overlap>0.6 matcher, one of three inconsistent answers in the
 * codebase).
 */

import {
  storyVector,
  cosineSimilarity,
  clusterTexts,
  STORY_SIMILARITY_THRESHOLD,
} from '../../../../shared/story-identity.js';

/** @param {string[]} headlines */
export function deduplicateHeadlines(headlines) {
  const seenVectors = [];
  const unique = [];
  for (const headline of headlines) {
    const vec = storyVector(headline);
    // Unvectorizable headlines (empty/punctuation-only) can't be compared;
    // keep them rather than silently dropping content.
    const isDuplicate = vec !== null
      && seenVectors.some((seen) => cosineSimilarity(vec, seen) >= STORY_SIMILARITY_THRESHOLD);
    if (!isDuplicate) {
      if (vec !== null) seenVectors.push(vec);
      unique.push(headline);
    }
  }
  return unique;
}

/**
 * Cluster a request batch of feed items into stories and assign each item
 * its cluster's canonical identity (#4919). Replaces the exact
 * sha256(normalizeTitle) identity that forked a story on ANY wording edit
 * and deflated corroboration to verbatim-syndication-only.
 *
 * Canonical id = hash of the normalized title of the EARLIEST-published
 * member (ties and missing timestamps fall back to the lexicographically
 * smallest normalized title). Anchoring on the oldest member keeps the
 * story:track identity stable while a story actively corroborates: a
 * newly-joining wording, by definition, publishes later and therefore can
 * never steal the canonical mid-lifecycle (PR #4924 review — reliability
 * P1 + the 3-incident story:track continuity history in
 * list-feed-digest.ts). The id changes only when the oldest member ages
 * out of the 96h window — the same orphaning every wording variant
 * suffered under exact hashing, so worst case equals old behavior.
 * (Residual, tracked as follow-up: a hostile feed can still backdate its
 * publishedAt within the freshness window to claim the canonical —
 * requires the cross-cycle adopt-existing-track hardening.)
 *
 * Items whose normalized title is EMPTY (emoji/punctuation-only) get a
 * per-item sentinel identity instead of sharing sha256("") — under exact
 * hashing all such items accumulated one phantom story:track row with
 * pooled corroboration.
 *
 * @template {{ title: string; source: string; publishedAt?: number }} T
 * @param {T[]} items
 * @param {(title: string) => string} normalizeTitle title normalizer
 *   (strips source suffixes etc. — stays caller-owned so hash identity is
 *   unchanged for singleton clusters)
 * @param {(text: string) => Promise<string>} sha256Hex
 * @returns {Promise<Map<T, { titleHash: string; corroborationCount: number }>>}
 */
export async function assignStoryIdentity(items, normalizeTitle, sha256Hex) {
  const clusters = clusterTexts(items.map((item) => item.title || ''));
  const assignment = new Map();
  await Promise.all(clusters.map(async (indices) => {
    let canonical = null;
    let canonicalPublishedAt = Infinity;
    for (const i of indices) {
      const normalized = normalizeTitle(items[i].title || '');
      if (!normalized) continue;
      const publishedAt = typeof items[i].publishedAt === 'number' && Number.isFinite(items[i].publishedAt)
        ? items[i].publishedAt
        : Infinity;
      if (
        canonical === null
        || publishedAt < canonicalPublishedAt
        || (publishedAt === canonicalPublishedAt && normalized < canonical)
      ) {
        canonical = normalized;
        canonicalPublishedAt = publishedAt;
      }
    }

    const sources = new Set();
    for (const i of indices) {
      if (items[i].source) sources.add(items[i].source);
    }
    const corroborationCount = Math.max(1, sources.size);

    if (canonical === null) {
      // Whole cluster normalizes to empty — sentinel identity per item,
      // no shared phantom track, no pooled corroboration.
      await Promise.all(indices.map(async (i) => {
        const titleHash = await sha256Hex(`untrackable:${items[i].source || ''}:${items[i].title || ''}`);
        // No alias rows for sentinel identities — they are per-item by design.
        assignment.set(items[i], { titleHash, corroborationCount: 1, memberTitleHashes: [] });
      }));
      return;
    }

    const titleHash = await sha256Hex(canonical);
    // Unique exact-title hashes of every member — the caller persists
    // memberHash->canonicalHash alias rows and adopts a live canonical on
    // later cycles (#4924 review P1: without this, cycle 1 = A+B with A
    // canonical wrote only A's track; a cycle-2 B-only batch hashed to B
    // and RESET the story to BREAKING/mentionCount=1 — worse than the old
    // exact hashing, where B's own track would have continued).
    const memberNormalized = new Set();
    for (const i of indices) {
      const normalized = normalizeTitle(items[i].title || '');
      if (normalized) memberNormalized.add(normalized);
    }
    const memberTitleHashes = await Promise.all([...memberNormalized].map((n) => sha256Hex(n)));
    for (const i of indices) {
      assignment.set(items[i], { titleHash, corroborationCount, memberTitleHashes });
    }
  }));
  return assignment;
}

/**
 * Pure canonical-adoption rule (#4924 review P1). Given a cluster's member
 * exact-title hashes, the batch-derived default canonical hash, and a map of
 * live alias rows (memberHash -> canonical hash written in a previous
 * cycle, same TTL as story tracks), return the hash the cluster should
 * track under: the live canonical most of its members already point at —
 * so a story keeps its identity when the original canonical member drops
 * out of the batch. Deterministic: most-common target wins, ties break to
 * the lexicographically smallest hash. No live alias -> default.
 */
export function adoptExistingCanonical(memberTitleHashes, defaultHash, aliasTargetByHash) {
  const counts = new Map();
  for (const memberHash of Array.isArray(memberTitleHashes) ? memberTitleHashes : []) {
    const target = aliasTargetByHash instanceof Map
      ? aliasTargetByHash.get(memberHash)
      : aliasTargetByHash?.[memberHash];
    if (typeof target !== 'string' || target.length === 0) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  let adopted = null;
  let best = 0;
  for (const [target, count] of counts) {
    if (count > best || (count === best && adopted !== null && target < adopted)) {
      adopted = target;
      best = count;
    }
  }
  return adopted ?? defaultHash;
}
