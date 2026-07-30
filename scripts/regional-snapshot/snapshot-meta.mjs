// @ts-check
// Builds SnapshotMeta. Confidence is computed from input freshness +
// completeness, then merged with model/scoring/geography versions.
//
// Phase 0 builds pre-meta (no narrative, no snapshot_id) and the seed entry
// fills in the final fields after compute completes.

import { classifyInputs, FRESHNESS_REGISTRY, resolveInputTimestamp } from './freshness.mjs';

export const MODEL_VERSION = '0.1.0';

/**
 * Hard upper bound for valid_until: snapshots are written on a 6h cron, so
 * even a fresh input with an effectively-infinite maxAgeMin (e.g.
 * national-debt at 86400 min) should not advertise the snapshot as valid
 * past the next scheduled write.
 */
const MAX_VALID_UNTIL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {Record<string, any>} sources
 * @param {string} scoringVersion
 * @param {string} geographyVersion
 * @param {Record<string, any>} [metaSources] - Companion seed-meta:* payloads
 *   used by classifyInputs to detect stalled seeders whose data payloads
 *   lack top-level timestamps. See freshness.mjs.
 * @returns {{
 *   pre: {
 *     model_version: string;
 *     scoring_version: string;
 *     geography_version: string;
 *     snapshot_confidence: number;
 *     missing_inputs: string[];
 *     stale_inputs: string[];
 *     valid_until: number;
 *     trigger_reason: 'scheduled_6h';
 *   };
 *   classification: { fresh: string[]; stale: string[]; missing: string[] };
 * }}
 */
export function buildPreMeta(sources, scoringVersion, geographyVersion, metaSources = {}) {
  // Snapshot a single `now` so the confidence math, valid_until lower bound,
  // and 6h cap all reference the same tick. Without this, deriveValidUntil's
  // internal Date.now() could drift past buildPreMeta's reference and force
  // tests to use timing tolerances to assert exact values.
  const now = Date.now();
  const classification = classifyInputs(sources, metaSources);
  const totalInputs = classification.fresh.length + classification.stale.length + classification.missing.length;
  const cCompleteness = totalInputs > 0
    ? (totalInputs - classification.missing.length) / totalInputs
    : 0;
  const presentInputs = totalInputs - classification.missing.length;
  const cFreshness = presentInputs > 0
    ? (presentInputs - classification.stale.length) / presentInputs
    : 0;
  const snapshot_confidence = round(0.6 * cCompleteness + 0.4 * cFreshness);

  return {
    pre: {
      model_version: MODEL_VERSION,
      scoring_version: scoringVersion,
      geography_version: geographyVersion,
      snapshot_confidence,
      missing_inputs: classification.missing,
      stale_inputs: classification.stale,
      valid_until: deriveValidUntil(classification.fresh, sources, metaSources, now),
      trigger_reason: 'scheduled_6h',
    },
    classification,
  };
}

/**
 * Derive valid_until from the minimum remaining TTL across fresh inputs.
 *
 * For each fresh input, the expiry is `ts + maxAgeMin * 60_000`. The
 * snapshot itself is only valid until the FIRST fresh input goes stale, so
 * we take the minimum. The result is then clamped:
 *   - lower bound: now (never advertise a snapshot as valid in the past)
 *   - upper bound: now + 6h (snapshots are rewritten on a 6h cron, so
 *     advertising further would be misleading even for inputs with very
 *     long maxAgeMin like national-debt at 60d)
 *
 * When no inputs are fresh (all stale or missing), valid_until collapses to
 * now so consumers know the snapshot is immediately invalid.
 *
 * `now` is passed in from buildPreMeta so the two-step (classify → derive)
 * computation references the same tick. Without this, tests would need
 * timing tolerance to assert exact valid_until values.
 *
 * @param {string[]} freshKeys
 * @param {Record<string, any>} sources
 * @param {Record<string, any>} metaSources
 * @param {number} now
 * @returns {number}
 */
function deriveValidUntil(freshKeys, sources, metaSources, now) {
  if (freshKeys.length === 0) return now;

  const freshSet = new Set(freshKeys);
  let earliestExpiry = Number.POSITIVE_INFINITY;
  for (const spec of FRESHNESS_REGISTRY) {
    if (!freshSet.has(spec.key)) continue;
    const ts = resolveInputTimestamp(spec, sources[spec.key], metaSources);
    // classifyInputs guarantees a parseable timestamp for any key it
    // returned in `fresh`. If that invariant ever drifts, skip the key
    // rather than producing NaN/Infinity here.
    if (ts === null) continue;
    const expiresAt = ts + spec.maxAgeMin * 60_000;
    if (expiresAt < earliestExpiry) earliestExpiry = expiresAt;
  }

  if (!Number.isFinite(earliestExpiry)) return now;
  if (earliestExpiry < now) return now;
  const cap = now + MAX_VALID_UNTIL_MS;
  return earliestExpiry > cap ? cap : earliestExpiry;
}

/**
 * Merge pre-meta with the fields that only become available after compute.
 *
 * @param {ReturnType<typeof buildPreMeta>['pre']} preMeta
 * @param {{
 *   snapshot_id: string;
 *   trigger_reason: import('../../shared/regions.types.js').TriggerReason;
 *   narrative_provider?: string;
 *   narrative_model?: string;
 * }} finalFields
 * @returns {import('../../shared/regions.types.js').SnapshotMeta}
 */
export function buildFinalMeta(preMeta, finalFields) {
  return {
    snapshot_id: finalFields.snapshot_id,
    model_version: preMeta.model_version,
    scoring_version: preMeta.scoring_version,
    geography_version: preMeta.geography_version,
    snapshot_confidence: preMeta.snapshot_confidence,
    missing_inputs: preMeta.missing_inputs,
    stale_inputs: preMeta.stale_inputs,
    valid_until: preMeta.valid_until,
    trigger_reason: finalFields.trigger_reason,
    narrative_provider: finalFields.narrative_provider ?? '',
    narrative_model: finalFields.narrative_model ?? '',
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
