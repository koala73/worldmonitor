// @ts-check
// Builds SnapshotMeta. Confidence is computed from input freshness +
// completeness, then merged with model/scoring/geography versions.
//
// Phase 0 builds pre-meta (no narrative, no snapshot_id) and the seed entry
// fills in the final fields after compute completes.

import { classifyInputs } from './freshness.mjs';

export const MODEL_VERSION = '0.1.0';

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
      valid_until: Date.now() + 6 * 60 * 60 * 1000, // 6h
      trigger_reason: 'scheduled_6h',
    },
    classification,
  };
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
