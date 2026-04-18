// Runtime surface for shared/brief-envelope.d.ts.
//
// The envelope is a pure data contract — no behaviour to export beyond
// the schema version constant. Types live in the sibling .d.ts and flow
// through JSDoc @typedef pointers below so .mjs consumers get editor
// hints without a build step.

/**
 * @typedef {import('./brief-envelope.js').BriefEnvelope} BriefEnvelope
 * @typedef {import('./brief-envelope.js').BriefData} BriefData
 * @typedef {import('./brief-envelope.js').BriefStory} BriefStory
 * @typedef {import('./brief-envelope.js').BriefDigest} BriefDigest
 * @typedef {import('./brief-envelope.js').BriefThread} BriefThread
 * @typedef {import('./brief-envelope.js').BriefThreatLevel} BriefThreatLevel
 */

/**
 * Schema version stamped on every Redis-resident brief. Bump when any
 * shape in brief-envelope.d.ts changes in a way that existing consumers
 * cannot ignore. Envelope-version drift is the primary failure mode for
 * this pipeline (see the seed-envelope-consumer-drift incident, PR
 * #3139) — coordinate every producer + consumer update in the same PR.
 *
 * v2 (2026-04): BriefStory.sourceUrl added. The renderer wraps the
 * `.source` line in an anchor with UTM tracking on v2 stories. Older
 * v1 envelopes already in Redis at rollout still render (anchor
 * omitted, matching pre-v2 appearance) so links issued in the
 * preceding 7-day TTL window don't regress to "expired" the moment
 * the renderer deploys. Once that window passes,
 * SUPPORTED_ENVELOPE_VERSIONS can shrink to [2] in a follow-up.
 *
 * @type {2}
 */
export const BRIEF_ENVELOPE_VERSION = 2;

/**
 * Versions the renderer still accepts from Redis on READ. Must always
 * contain the current BRIEF_ENVELOPE_VERSION plus any versions that
 * may still be live in the 7-day brief TTL window. The composer only
 * ever writes the current version — this set is a read-side
 * compatibility shim, not a producer-side choice.
 *
 * @type {ReadonlySet<number>}
 */
export const SUPPORTED_ENVELOPE_VERSIONS = new Set([1, 2]);
