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
const INT64_SCHEMA = {
  type: 'integer',
  format: 'int64',
  description: 'Warning: Values > 2^53 may lose precision in JavaScript',
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

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

function availableComponentName(bucket, preferred, value) {
  if (!bucket[preferred] || eq(bucket[preferred], value)) return preferred;
  let suffix = 2;
  while (bucket[`${preferred}_${suffix}`] && !eq(bucket[`${preferred}_${suffix}`], value)) suffix += 1;
  return `${preferred}_${suffix}`;
}

function headerComponentName(headerName) {
  const stem = headerName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
  return `${stem || 'Shared'}Header`;
}

/**
 * Hoist response Header Objects that repeat under the same header name.
 * OpenAPI permits a Header Object or Reference Object at every response-header
 * site, so resolving the emitted refs reproduces the source document exactly.
 */
export function dedupeSharedResponseHeaders(spec) {
  const stats = { hoisted: 0, replacedRefs: 0 };
  const groups = new Map();

  for (const pathItem of Object.values(spec?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      for (const response of Object.values(operation?.responses ?? {})) {
        for (const [headerName, header] of Object.entries(response?.headers ?? {})) {
          if (!header || typeof header !== 'object' || header.$ref) continue;
          const key = `${headerName}\0${JSON.stringify(header)}`;
          const group = groups.get(key) ?? { headerName, header, sites: [] };
          group.sites.push(response.headers);
          groups.set(key, group);
        }
      }
    }
  }

  const repeated = [...groups.values()].filter((group) => group.sites.length >= 2);
  if (repeated.length === 0) return stats;
  spec.components ??= {};
  spec.components.headers ??= {};

  for (const group of repeated) {
    const name = availableComponentName(
      spec.components.headers,
      headerComponentName(group.headerName),
      group.header,
    );
    spec.components.headers[name] ??= structuredClone(group.header);
    for (const headers of group.sites) {
      headers[group.headerName] = { $ref: `#/components/headers/${pointerSegment(name)}` };
      stats.replacedRefs += 1;
    }
    stats.hoisted += 1;
  }
  return stats;
}

/** Reuse sebuf's exact repeated int64 precision-warning schema. */
export function dedupeRepeatedInt64Schemas(spec) {
  const stats = { replacedRefs: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;
  const sites = [];

  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object' && eq(child, INT64_SCHEMA)) sites.push({ parent: value, key });
      else visit(child);
    }
  };
  for (const schema of Object.values(schemas)) visit(schema);
  if (sites.length < 2) return stats;

  const name = availableComponentName(schemas, 'WorldMonitorInt64', INT64_SCHEMA);
  schemas[name] ??= structuredClone(INT64_SCHEMA);
  for (const { parent, key } of sites) {
    parent[key] = { $ref: `#/components/schemas/${pointerSegment(name)}` };
    stats.replacedRefs += 1;
  }
  return stats;
}

/** Reuse the exact date-precision union repeated by China decision-signal claims. */
export function dedupeRepeatedChinaDateSchemas(spec) {
  const stats = { replacedRefs: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;
  const decisionItem = Object.entries(schemas).find(([name]) => name.endsWith('ChinaDecisionSignalItem'))?.[1];
  const exemplar = decisionItem?.properties?.effectiveAt?.oneOf?.[0];
  if (!exemplar || typeof exemplar !== 'object') return stats;
  const sites = [];

  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const child = value[index];
        if (child && typeof child === 'object' && eq(child, exemplar)) sites.push({ parent: value, key: index });
        else visit(child);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object' && eq(child, exemplar)) sites.push({ parent: value, key });
      else visit(child);
    }
  };
  for (const schema of Object.values(schemas)) visit(schema);
  if (sites.length < 2) return stats;

  const name = availableComponentName(schemas, 'WorldMonitorChinaDatePrecision', exemplar);
  schemas[name] ??= structuredClone(exemplar);
  for (const { parent, key } of sites) {
    parent[key] = { $ref: `#/components/schemas/${pointerSegment(name)}` };
    stats.replacedRefs += 1;
  }
  return stats;
}
