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
// #6428: corroboration counts PUBLISHERS. `item.source` is a feed label, and
// one newsroom ships many ("Reuters World", "Reuters US", …), so counting
// labels let a wire corroborate itself.
import { countPublisherFamilies } from '../../../../shared/publisher-families.js';

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
 * publishedAt is publisher-controlled, so a hostile feed can backdate
 * inside the freshness window to win this comparison (#4925 item 1). That
 * is why the batch-derived canonical is only a DEFAULT: the caller passes
 * it through adoptExistingCanonical, which prefers server-side Redis state
 * a feed cannot fake.
 *
 * Items whose normalized title is EMPTY (emoji/punctuation-only) get a
 * per-item sentinel identity instead of sharing sha256("") — under exact
 * hashing all such items accumulated one phantom story:track row with
 * pooled corroboration.
 *
 * @template {{ title: string; source: string; originPublisher?: string; publishedAt?: number }} T
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

    // #6430: the originating publisher (RSS <source>, carried as
    // originPublisher) outranks the feed label — one wire under several
    // feeds' labels is one publisher. Absent (direct feeds, Atom), the
    // feed label remains the best available signal.
    const corroborationCount = Math.max(
      1,
      countPublisherFamilies(indices.map((i) => items[i].originPublisher || items[i].source)),
    );

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
 * Pure canonical-adoption rule (#4924 review P1, extended by #4925 item 1).
 * Given a cluster's member exact-title hashes, the batch-derived default
 * canonical hash, a map of live alias rows (memberHash -> canonical hash
 * written in a previous cycle, same TTL as story tracks) and a map of live
 * story:track first-seen stamps, return the hash the cluster should track
 * under. Three rules, in order:
 *
 *   1. The OLDEST member hash that already anchors a live story:track row.
 *      firstSeen is HSETNX'd by the digest at first observation, so it is
 *      server-side state a feed cannot fake — unlike publishedAt, which
 *      decides the batch-derived default and is publisher-controlled. This
 *      is what stops a feed that backdates inside the freshness window from
 *      seizing a live story's identity, and what stops an attacker who can
 *      place several member hashes in the cluster from out-voting the
 *      genuine story under rule 2 (#4925 item 1).
 *   2. Otherwise the live canonical most of the members already point at,
 *      so a story keeps its identity when the original canonical member
 *      drops out of the batch (#4924). Rule 1 cannot cover this case: a
 *      canonical absent from the batch is not one of the member hashes, so
 *      it has no track row to find here.
 *   3. Otherwise the batch-derived default.
 *
 * Deterministic throughout: oldest firstSeen wins, then most-common alias
 * target wins, and both tie-break to the lexicographically smallest hash.
 *
 * Stays pure — the caller owns the Redis reads and decides which track rows
 * count as live.
 */
export function adoptExistingCanonical(
  memberTitleHashes,
  defaultHash,
  aliasTargetByHash,
  trackFirstSeenByHash,
) {
  const members = Array.isArray(memberTitleHashes) ? memberTitleHashes : [];

  let oldestHash = null;
  let oldestFirstSeen = Infinity;
  for (const memberHash of members) {
    const firstSeen = trackFirstSeenByHash instanceof Map
      ? trackFirstSeenByHash.get(memberHash)
      : trackFirstSeenByHash?.[memberHash];
    if (typeof firstSeen !== 'number' || !Number.isFinite(firstSeen)) continue;
    if (
      oldestHash === null
      || firstSeen < oldestFirstSeen
      || (firstSeen === oldestFirstSeen && memberHash < oldestHash)
    ) {
      oldestHash = memberHash;
      oldestFirstSeen = firstSeen;
    }
  }
  if (oldestHash !== null) return oldestHash;

  const counts = new Map();
  for (const memberHash of members) {
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
