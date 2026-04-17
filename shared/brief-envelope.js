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
 * @type {1}
 */
export const BRIEF_ENVELOPE_VERSION = 1;
