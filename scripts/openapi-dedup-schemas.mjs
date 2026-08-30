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

const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_SINGLE_KEYS = new Set([
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const MIN_SHARED_SCHEMA_BYTES = 80;
const MIN_GROUP_SAVING_BYTES = 256;

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

function schemaChildren(schema) {
  const children = [];
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          children.push({ parent: value, key: childKey, schema: child });
        }
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((child, index) => {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          children.push({ parent: value, key: index, schema: child });
        }
      });
    } else if (
      SCHEMA_SINGLE_KEYS.has(key)
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
    ) {
      children.push({ parent: schema, key, schema: value });
    }
  }
  return children;
}

/**
 * Replace byte-identical nested Schema Objects with local references to their
 * shortest existing occurrence. The target remains inline, so this pass adds
 * no synthetic schema and changes no validation or documentation semantics.
 *
 * Groups are selected largest-saving first and may not overlap. This prevents
 * a later ref from replacing an ancestor of an earlier target, which would
 * leave a valid JSON pointer pointing into a node that no longer exists.
 *
 * Mutates `spec` in place; returns exact byte savings and engagement counts.
 */
export function dedupeSharedSchemaSubtrees(spec) {
  const stats = { groups: 0, replacedRefs: 0, bytesFreed: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;

  const beforeBytes = Buffer.byteLength(JSON.stringify(spec), 'utf8');
  const parentOf = new Map();
  const groups = new Map();

  const visit = (schema, parent, key, pointer) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.$ref) return;
    parentOf.set(schema, parent);
    const serialized = canonical(schema);
    const unitBytes = Buffer.byteLength(serialized, 'utf8');
    const site = { schema, parent, key, pointer, unitBytes };
    if (unitBytes >= MIN_SHARED_SCHEMA_BYTES) {
      const group = groups.get(serialized);
      if (group) group.push(site);
      else groups.set(serialized, [site]);
    }
    for (const child of schemaChildren(schema)) {
      // Property maps and composition arrays sit between a Schema Object and
      // its child in the mutable tree. Record that container edge as well so
      // overlap detection can see that `properties.at` is inside its owning
      // component schema rather than treating the two candidates as peers.
      if (child.parent !== schema) parentOf.set(child.parent, schema);
      const segment = pointerSegment(String(child.key));
      const containerKey = child.parent === schema ? '' : Object.entries(schema)
        .find(([, value]) => value === child.parent)?.[0];
      const childPointer = child.parent === schema
        ? `${pointer}/${segment}`
        : `${pointer}/${pointerSegment(containerKey)}/${segment}`;
      visit(child.schema, child.parent, child.key, childPointer);
    }
  };

  for (const [name, schema] of Object.entries(schemas)) {
    visit(schema, schemas, name, `#/components/schemas/${pointerSegment(name)}`);
  }

  const selected = new Set();
  const ancestors = new Set();
  const overlaps = (node) => {
    if (selected.has(node) || ancestors.has(node)) return true;
    let parent = parentOf.get(node);
    while (parent) {
      if (selected.has(parent)) return true;
      parent = parentOf.get(parent);
    }
    return false;
  };
  const mark = (node) => {
    selected.add(node);
    let parent = parentOf.get(node);
    while (parent) {
      ancestors.add(parent);
      parent = parentOf.get(parent);
    }
  };

  const candidates = [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => {
      const ordered = [...group].sort(
        (a, b) => a.pointer.length - b.pointer.length || a.pointer.localeCompare(b.pointer),
      );
      const target = ordered[0];
      const refBytes = Buffer.byteLength(JSON.stringify({ $ref: target.pointer }), 'utf8');
      return {
        ordered,
        estimatedSaving: ordered.slice(1)
          .reduce((sum, site) => sum + Math.max(0, site.unitBytes - refBytes), 0),
      };
    })
    .filter((candidate) => candidate.estimatedSaving >= MIN_GROUP_SAVING_BYTES)
    .sort((a, b) => b.estimatedSaving - a.estimatedSaving);

  for (const candidate of candidates) {
    const free = candidate.ordered.filter((site) => !overlaps(site.schema));
    if (free.length < 2) continue;
    const target = free[0];
    const replacements = free.slice(1).filter((site) => {
      const refBytes = Buffer.byteLength(JSON.stringify({ $ref: target.pointer }), 'utf8');
      return site.unitBytes > refBytes;
    });
    if (replacements.length === 0) continue;
    const saving = replacements.reduce((sum, site) => {
      const refBytes = Buffer.byteLength(JSON.stringify({ $ref: target.pointer }), 'utf8');
      return sum + site.unitBytes - refBytes;
    }, 0);
    if (saving < MIN_GROUP_SAVING_BYTES) continue;

    mark(target.schema);
    for (const site of replacements) {
      mark(site.schema);
      site.parent[site.key] = { $ref: target.pointer };
      stats.replacedRefs += 1;
    }
    stats.groups += 1;
  }

  stats.bytesFreed = beforeBytes - Buffer.byteLength(JSON.stringify(spec), 'utf8');
  return stats;
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
