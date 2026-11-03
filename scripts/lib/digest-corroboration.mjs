/**
 * Per-item corroboration for chat and email digests (#9213).
 *
 * list-feed-digest stores the verdict each variant served on the story's
 * track row (STORY_CORROBORATION_FIELD in server/_shared/label-history.ts).
 * The digest reads it from there rather than recomputing it; a story the
 * digest merged from several clusters combines their stored verdicts with
 * mergeCorroboration.
 */

import { createRequire } from 'node:module';

import { countPublisherFamilies } from '../shared/publisher-families.js';

const require = createRequire(import.meta.url);
const { corroborationText, mergeCorroboration } = require('./corroboration-text.cjs');

/** Track-row field for a digest variant; tests/digest-corroboration.test.mts pins it to the server's. */
export function storyCorroborationField(variant, lang) {
  return `corroboration:${variant}:${lang}`;
}

/** The stored value for a variant, or '' when the row has none. */
export function readStoryCorroboration(track, variant, lang) {
  const value = track?.[storyCorroborationField(variant, lang)];
  return typeof value === 'string' ? value : '';
}

/**
 * Sets `corroboration` ({state, publishers} or null) on every digest story,
 * from the stored verdicts of the hashes it was merged from. `stories` is the
 * pre-dedup pool, which carries each hash's stored value; `sources` on each
 * rep must already be hydrated.
 */
export function attachDigestCorroboration(reps, stories) {
  const storedByHash = new Map();
  for (const story of stories ?? []) {
    if (typeof story?.hash === 'string') storedByHash.set(story.hash, story.corroboration);
  }
  for (const rep of reps ?? []) {
    const hashes = Array.isArray(rep.mergedHashes) && rep.mergedHashes.length > 0 ? rep.mergedHashes : [rep.hash];
    rep.corroboration = mergeCorroboration(
      hashes.map((hash) => storedByHash.get(hash)),
      countPublisherFamilies(Array.isArray(rep.sources) ? rep.sources : []),
    );
  }
  return reps;
}

/** "Coverage: …" for a digest item, or '' when its verdict is unknown. */
export function digestCoverageText(story) {
  const text = corroborationText(story?.corroboration);
  return text ? `Coverage: ${text}` : '';
}

/** One story in the digest webhook body; `corroboration` only when known. */
export function digestWebhookStory(s) {
  return {
    title: s.title,
    severity: s.severity,
    phase: s.phase,
    sources: s.sources,
    ...(s.corroboration ? { corroboration: s.corroboration } : {}),
  };
}
