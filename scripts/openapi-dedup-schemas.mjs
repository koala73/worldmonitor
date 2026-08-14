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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function knownClaim(claim) {
  const index = claim?.oneOf?.findIndex(
    (candidate) => candidate?.properties?.status?.const === 'known',
  );
  if (index === undefined || index < 0) return null;
  const branch = claim.oneOf[index];
  return branch && typeof branch === 'object' ? { index, branch } : null;
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
    // The two injectors use the same known-claim builder. Compare the complete
    // branch before reusing it so descriptions, constraints, and value shape
    // cannot be hidden by a narrower comparison.
    if (!eq(corridorKnown.branch, decisionKnown.branch)) continue;

    corridorClaim.oneOf[corridorKnown.index] = {
      $ref:
        `#/components/schemas/${pointerSegment(decisionEntry[0])}` +
        `/properties/${pointerSegment(dimension)}` +
        `/oneOf/${decisionKnown.index}`,
    };
    stats.replacedRefs += 1;
  }

  return stats;
}

/**
 * Hoist byte-identical direct component-property schemas into short, shared
 * components when (and only when) doing so makes the serialized document
 * smaller. Generated protobuf schemas repeat complete enum, timestamp and
 * pagination-property definitions across messages. Replacing the whole
 * property schema with a document-local OpenAPI 3.1 $ref preserves every
 * description and validation keyword while avoiding duplicated JSON.
 *
 * Restricting the transform to direct `components.schemas.*.properties.*`
 * sites makes replacements non-overlapping. The lossless regression test can
 * therefore expand every generated ref and compare the full document with the
 * pre-transform source exactly.
 *
 * Mutates `spec` in place; returns { hoisted, replacedRefs, bytesSaved }.
 */
export function dedupeSharedComponentPropertySchemas(spec) {
  const stats = { hoisted: 0, replacedRefs: 0, bytesSaved: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;

  const groups = new Map();
  const sites = [];
  for (const [componentName, componentSchema] of Object.entries(schemas)) {
    const properties = componentSchema?.properties;
    if (!properties || typeof properties !== 'object') continue;
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== 'object' || propertySchema.$ref) continue;
      const key = canonical(propertySchema);
      const group = groups.get(key);
      if (group) group.count += 1;
      else groups.set(key, { count: 1, body: propertySchema });
      sites.push({ componentName, properties, propertyName, key });
    }
  }

  const nameFor = new Map();
  let ordinal = 0;
  for (const [key, group] of groups) {
    if (group.count < 2) continue;
    let name;
    do {
      ordinal += 1;
      name = `SharedPropertySchema${ordinal}`;
    } while (Object.hasOwn(schemas, name));

    const ref = { $ref: `#/components/schemas/${name}` };
    // Account for every replaced value plus the new component key/value. The
    // one-byte allowance covers the comma inserted into components.schemas.
    const originalBytes = group.count * JSON.stringify(group.body).length;
    const replacementBytes =
      group.count * JSON.stringify(ref).length +
      JSON.stringify(name).length +
      1 +
      JSON.stringify(group.body).length +
      1;
    const bytesSaved = originalBytes - replacementBytes;
    if (bytesSaved <= 0) continue;

    nameFor.set(key, { name, bytesSaved });
  }

  if (nameFor.size === 0) return stats;

  for (const [key, { name, bytesSaved }] of nameFor) {
    schemas[name] = groups.get(key).body;
    stats.hoisted += 1;
    stats.bytesSaved += bytesSaved;
  }
  for (const site of sites) {
    const selected = nameFor.get(site.key);
    if (!selected) continue;
    site.properties[site.propertyName] = {
      $ref: `#/components/schemas/${selected.name}`,
    };
    stats.replacedRefs += 1;
  }

  return stats;
}
