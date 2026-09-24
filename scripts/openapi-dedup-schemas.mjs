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
// The schema byte floor was lowered from 80 to 56 and the group saving floor
// from 256 to 96 when #7400 brought the bundle close to its three-operation
// reserve. Energy import metadata later left the bundle 276 bytes short of that
// reserve. Lowering the group floor from 96 to 72 recovers 326 bytes through
// the same lossless transform. The bilateral evidence-depth fields (#7990) then
// crossed the hard cap with 81 bytes of headroom on the branch point; 56/72 ->
// 48/48 recovers a further 387 bytes, and lowering either floor below that
// yields nothing — the remaining groups are the deliberately inlined typed
// parameters, not repetition. The floor still exceeds each replacement ref's
// cost, so selected groups always reduce the served artifact.
// The pass stays lossless either way — every transform is resolved back to the
// source document in tests — so the thresholds only trade emit time for bytes.
const MIN_SHARED_SCHEMA_BYTES = 48;
const MIN_GROUP_SAVING_BYTES = 48;

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

/**
 * Component-name prefix for the subtree hoist below. Compact on purpose: the
 * name is paid at every ref, exactly like the `E<status>` response names in
 * openapi-dedup-responses.mjs — `WMShared12` buys back ~19 bytes per site over
 * a descriptive name, which is most of the yield on the 60-70 byte subtrees
 * this pass exists for.
 */
export const SHARED_SUBTREE_COMPONENT_PREFIX = 'WMShared';

/**
 * Collect every Schema Object node that an existing document-local `$ref`
 * resolves THROUGH: each node on the pointer path, including the target.
 *
 * A hoist that replaced any of those nodes with a component ref would change
 * what the existing ref resolves to (or dangle it), so they are off limits as
 * hoist sites. Descendants of a target stay eligible — replacing one leaves
 * the target resolvable, and full dereference still reproduces the source
 * document (the served artifact already leans on this: corridor value refs
 * point into ChinaDecisionSignalProvenanceClaims, whose inner subtrees the
 * inline pass edits).
 */
function refPointerPathNodes(spec) {
  const marked = new Set();
  const collectRefs = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) collectRefs(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) collectRefs(child);
    if (typeof value.$ref === 'string') {
      let node = spec;
      for (const raw of value.$ref.replace(/^#\//, '').split('/')) {
        const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
        if (node == null || typeof node !== 'object') return;
        node = Array.isArray(node) ? node[Number(segment)] : node[segment];
        if (node && typeof node === 'object') marked.add(node);
      }
    }
  };
  collectRefs(spec);
  return marked;
}

/**
 * Hoist groups of byte-identical Schema Objects into shared component schemas.
 *
 * `dedupeSharedSchemaSubtrees` already collapses the groups whose shortest
 * occurrence yields a SHORT $ref: it points the duplicates at one inline copy
 * and adds no component. What survives it are the groups whose every site sits
 * deep in a long-named component — the China provenance precision wrappers, the
 * repeated consumer-price freshness booleans — where the pointer INTO the
 * document is longer than the subtree itself, so an inline-target ref would
 * cost more than the repetition it removes. This pass is the escape hatch for
 * exactly those groups: the subtree moves into `components.schemas` under a
 * compact `WMShared<N>` name and every site, including the first, becomes a
 * short ref.
 *
 * Naming follows the dedupeErrorResponses precedent: deterministic (first-seen
 * ordinal in greedy largest-saving-first order, so identical input rebuilds
 * byte-identically) and paid at every ref, hence the short prefix. The hoist is
 * lossless — the component holds a byte-identical clone of one site, so
 * resolving the refs reproduces the source document; the contract test resolves
 * them back. Runs AFTER dedupeSharedSchemaSubtrees, so groups the inline pass
 * could profitably collapse never reach this one, and BEFORE the parameter
 * passes, which do not touch Schema Objects.
 *
 * Mutates `spec` in place; returns { groups, replacedRefs, bytesFreed }.
 */
export function dedupeSharedSubtreeComponents(spec) {
  const stats = { groups: 0, replacedRefs: 0, bytesFreed: 0 };
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return stats;

  const beforeBytes = Buffer.byteLength(JSON.stringify(spec), 'utf8');
  const untouchable = refPointerPathNodes(spec);
  const parentOf = new Map();
  const groups = new Map();

  // Same traversal and overlap bookkeeping as dedupeSharedSchemaSubtrees — the
  // only difference is the replacement strategy (named component ref instead of
  // ref-to-shortest-inline-copy) and therefore the profitability arithmetic.
  const visit = (schema, parent, key) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.$ref) return;
    parentOf.set(schema, parent);
    const serialized = canonical(schema);
    const unitBytes = Buffer.byteLength(serialized, 'utf8');
    if (unitBytes >= MIN_SHARED_SCHEMA_BYTES) {
      const site = { schema, parent, key };
      const group = groups.get(serialized);
      if (group) group.push(site);
      else groups.set(serialized, [site]);
    }
    for (const child of schemaChildren(schema)) {
      if (child.parent !== schema) parentOf.set(child.parent, schema);
      visit(child.schema, child.parent, child.key);
    }
  };
  for (const [name, schema] of Object.entries(schemas)) visit(schema, schemas, name);

  // Ref bytes for a name two ordinals wide: `WMShared99`. Selection only needs
  // a stable estimate; the exact per-group saving is recomputed once the group
  // is picked and named.
  const estimatedRefBytes = Buffer.byteLength(
    JSON.stringify({ $ref: `#/components/schemas/${SHARED_SUBTREE_COMPONENT_PREFIX}99` }),
    'utf8',
  );

  const candidates = [...groups.values()]
    .filter((sites) => sites.length >= 2)
    .map((sites) => {
      const unitBytes = Buffer.byteLength(canonical(sites[0].schema), 'utf8');
      return {
        sites,
        unitBytes,
        estimatedSaving: (sites.length - 1) * unitBytes - sites.length * estimatedRefBytes,
      };
    })
    .filter((candidate) => candidate.estimatedSaving >= MIN_GROUP_SAVING_BYTES)
    .sort((a, b) => b.estimatedSaving - a.estimatedSaving);

  const selected = new Set();
  const ancestors = new Set();
  const overlaps = (node) => {
    if (ancestors.has(node) || untouchable.has(node)) return true;
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
    while (parent && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = parentOf.get(parent);
    }
  };

  spec.components ??= {};
  spec.components.schemas ??= {};
  let ordinal = 0;
  for (const candidate of candidates) {
    const free = candidate.sites.filter((site) => !overlaps(site.schema));
    if (free.length < 2) continue;
    let name;
    do {
      ordinal += 1;
      name = `${SHARED_SUBTREE_COMPONENT_PREFIX}${ordinal}`;
    } while (Object.hasOwn(spec.components.schemas, name));
    const ref = { $ref: `#/components/schemas/${name}` };
    const refBytes = Buffer.byteLength(JSON.stringify(ref), 'utf8');
    const saving = free.length * candidate.unitBytes - candidate.unitBytes - free.length * refBytes;
    if (saving < MIN_GROUP_SAVING_BYTES) continue;

    // The component holds the first free site's bytes verbatim; every free
    // site — that one included — becomes a ref, so the subtree costs `unit`
    // bytes once instead of `free.length` times.
    spec.components.schemas[name] = structuredClone(free[0].schema);
    for (const site of free) {
      site.parent[site.key] = ref;
      mark(site.schema);
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
 *
 * `components.responses` counts as a site bucket too: dedupeErrorResponses
 * hoists repeated error bodies (E403 and friends) there BEFORE this pass runs,
 * moving their per-op headers out of `spec.paths` — a paths-only walk would
 * leave identical billing-verification headers duplicated across every hoisted
 * error component.
 */
export function dedupeSharedResponseHeaders(spec) {
  const stats = { hoisted: 0, replacedRefs: 0 };
  const groups = new Map();
  const collect = (responses) => {
    for (const response of Object.values(responses ?? {})) {
      for (const [headerName, header] of Object.entries(response?.headers ?? {})) {
        if (!header || typeof header !== 'object' || header.$ref) continue;
        const key = `${headerName}\0${JSON.stringify(header)}`;
        const group = groups.get(key) ?? { headerName, header, sites: [] };
        group.sites.push(response.headers);
        groups.set(key, group);
      }
    }
  };

  for (const pathItem of Object.values(spec?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      collect(operation?.responses);
    }
  }
  collect(spec?.components?.responses);

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
