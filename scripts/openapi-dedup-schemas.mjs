/**
 * Reuse the structurally identical provenance value schemas emitted for the China
 * corridor and decision-signal surfaces in the unified public OpenAPI JSON.
 *
 * Both injectors intentionally call the same provenanceValueSchema() builder.
 * The human-facing per-service artifacts keep their schemas inline, while the
 * unified machine artifact can point the corridor copy at the matching
 * decision-signal schema. The comparison fails closed: any future divergence
 * leaves both schemas inline instead of hiding the mismatch behind a $ref.
 */

import { eq } from './lib/openapi-codegen.mjs';

const CORRIDOR_SCHEMA_SUFFIX = 'ChinaCorridorProvenance';
const DECISION_CLAIMS_SCHEMA_SUFFIX = 'ChinaDecisionSignalProvenanceClaims';

function pointerSegment(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function knownClaim(claim) {
  const index = claim?.oneOf?.findIndex(
    (candidate) => candidate?.properties?.status?.const === 'known',
  );
  if (index === undefined || index < 0) return null;
  const value = claim.oneOf[index]?.properties?.value;
  return value && typeof value === 'object' ? { index, value } : null;
}

/**
 * Mutates `spec` in place; returns { compared, replacedRefs } stats.
 */
export function dedupeSharedChinaProvenanceSchemas(spec) {
  const stats = { compared: 0, replacedRefs: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;

  const corridorEntry = Object.entries(schemas).find(([name]) =>
    name.endsWith(CORRIDOR_SCHEMA_SUFFIX));
  const decisionEntry = Object.entries(schemas).find(([name]) =>
    name.endsWith(DECISION_CLAIMS_SCHEMA_SUFFIX));
  if (!corridorEntry || !decisionEntry) return stats;

  const corridorClaims = corridorEntry[1]?.properties?.claims?.properties;
  const decisionClaims = decisionEntry[1]?.properties;
  if (!corridorClaims || !decisionClaims) return stats;

  for (const [dimension, corridorClaim] of Object.entries(corridorClaims)) {
    const decisionClaim = decisionClaims[dimension];
    if (!decisionClaim) continue;
    stats.compared += 1;

    const corridorKnown = knownClaim(corridorClaim);
    const decisionKnown = knownClaim(decisionClaim);
    if (!corridorKnown || !decisionKnown) continue;
    if (!eq(corridorKnown.value, decisionKnown.value)) continue;

    corridorClaim.oneOf[corridorKnown.index].properties.value = {
      $ref:
        `#/components/schemas/${pointerSegment(decisionEntry[0])}` +
        `/properties/${pointerSegment(dimension)}` +
        `/oneOf/${decisionKnown.index}/properties/value`,
    };
    stats.replacedRefs += 1;
  }

  return stats;
}
