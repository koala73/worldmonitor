#!/usr/bin/env node
/**
 * Capacity report for the unified public/openapi.json (#6558).
 *
 * The artifact is a recurring capacity risk for agent-readiness scanners: they
 * cap spec bodies around 1 MB, and ora.ai/orank's function-calling check
 * degrades from a computed verdict to "couldn't validate" above it (#4852).
 * `tests/openapi-json-dedup.test.mjs` guards the ceiling, but a guard only
 * speaks the moment it breaks — it reports nothing on the way there, so the
 * last three crossings were each discovered by a red build on the PR that
 * happened to be last in line (#4852, #6440's food-stocks operation, the
 * billing-verification 503 that landed 497 bytes over).
 *
 * This reports the number the guard is silent about: how many bytes the served
 * artifact actually spends, how many are left, and — when the answer is "not
 * many" — which repeated or generated structures are worth collapsing next.
 *
 * Measurement contract:
 *   - Bytes come from `buildBundle()` in build-openapi-json.mjs, the same call
 *     that writes the artifact. A re-implementation here could drift from what
 *     is served; an import cannot.
 *   - Bytes are UTF-8 bytes, not `String#length`. The cap is a body-size cap in
 *     bytes and the descriptions carry non-ASCII punctuation, so the two
 *     numbers differ (264 bytes apart on the 2026-08-13 bundle) and only one of
 *     them is what a scanner fetches.
 *
 * Usage:
 *   node scripts/openapi-capacity-report.mjs               # human summary
 *   node scripts/openapi-capacity-report.mjs --json        # report to stdout
 *   node scripts/openapi-capacity-report.mjs --out cap.json
 *
 * Exit codes (every non-pass is nonzero):
 *   0  measured; artifact within budget (a breached reserve warns, see below)
 *   1  artifact is OVER budget
 *   2  the tool was misused (bad args, unwritable --out)
 *   3  the bundle could not be measured (no operations, no bytes)
 *
 * A breached reserve exits 0 on purpose. The ceiling already has a gate; a
 * second hard failure at the same wall would just be the same red build one
 * commit earlier. The reserve is an advisory number that makes the trend
 * legible while there is still room to act on it.
 */

import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build-openapi-json.mjs';
import { unreachableSchemaNames } from './openapi-drop-unreachable-schemas.mjs';

/**
 * The scanner budget, in bytes of the served artifact.
 *
 * Single source of truth: `tests/openapi-json-dedup.test.mjs` imports this
 * rather than restating it, so the gate and the report can never disagree about
 * where the wall is. Raising it is NOT the remedy for a crossing — the cap
 * belongs to the scanner, not to us, and the value is separately pinned by a
 * literal assertion in that test so a raise cannot pass as a one-line edit.
 */
export const SCANNER_BUDGET_BYTES = 950_000;

/**
 * How many more typical operations the artifact should be able to absorb before
 * the capacity work becomes urgent.
 *
 * Derived, not invented: the unit is this bundle's own mean cost per operation,
 * so "reserve" always means "room for N more operations like the ones already
 * here" even as the spec's shape changes. Three is the observed lead time —
 * #6531 landed one operation into 1.7 KB of headroom, which is less than one
 * operation's worth, and the fix had to be found inside that same PR.
 */
export const RESERVE_OPERATIONS = 3;

/**
 * Byte cost of the `{"$ref":"#/components/…/Name"}` that replaces a hoisted
 * subtree. Deliberately an over-estimate of the common case (~36-44 bytes) so
 * the reported yield of a reduction is a floor rather than a promise.
 */
export const ESTIMATED_REF_BYTES = 44;

/**
 * Subtrees smaller than this are ignored by the repetition analysis. Below it
 * the $ref that would replace a repeat costs a meaningful fraction of the
 * repeat itself, and the list degenerates into thousands of `{"type":"string"}`.
 */
export const MIN_REPEATED_SUBTREE_BYTES = 96;

/** How many entries each ranked list carries into the report. */
export const TOP_N = 20;

/**
 * Operation-count floor below which the bundle is treated as not generated.
 *
 * `bytes > 0 && operations > 0` only catches the impossible case — a committed
 * 2.6 MB source YAML does not produce an empty document. The plausible failure
 * is a PARTIAL generation: a codegen or injector change that emits a handful of
 * operations, which would report a delighted 900 KB of headroom. The bundle has
 * grown monotonically through 193 -> 217 -> 219 operations; 100 is far below
 * anything real and far above anything a broken generator would produce.
 */
export const MIN_PLAUSIBLE_OPERATIONS = 100;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

// Which document positions can actually hold a `$ref`. An ALLOW-list, not a
// deny-list: a position nobody thought about must fall out of the estimate
// rather than into it, because the number this feeds is a promise about bytes
// a future edit can spend. Counting an unreferenceable position is how a
// reduction plan offers savings no edit can take — `responses.200.headers` is
// a `Map[string, Header | Reference]`, so each ENTRY can become a `$ref` while
// the map itself cannot, and `content['application/json']` is a Media Type
// Object, which OpenAPI 3.1 does not allow a Reference in at all.

/** Single-value slots that hold a Schema (or Reference) directly. */
const REF_SLOT_KEYS = new Set([
  'schema', 'items', 'not', 'additionalProperties', 'contains', 'propertyNames',
  'if', 'then', 'else', 'requestBody',
]);

/** Array-valued keys whose ELEMENTS hold a Schema (or Reference). */
const REF_ARRAY_KEYS = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems', 'parameters']);

/** Maps whose ENTRIES hold a referenceable Object. */
const REF_ENTRY_CONTAINERS = new Set([
  'properties', 'patternProperties', 'dependentSchemas', 'definitions', '$defs',
  'schemas', 'responses', 'headers', 'parameters', 'requestBodies', 'examples',
  'links', 'callbacks', 'securitySchemes',
]);

/**
 * Keys whose value is arbitrary instance data, not a referenceable Object.
 *
 * `example` holds a literal payload; `enum`/`const`/`default` hold values. Their
 * CONTENTS are excluded too — an example payload can contain a key called
 * `schema` or `properties` without any of it being an OpenAPI construct.
 */
const RAW_DATA_KEYS = new Set(['example', 'enum', 'const', 'default']);

/** Can a `$ref` stand where this node stands? */
function isReferenceablePosition(parentKey, grandparentKey, inRawData) {
  if (inRawData) return false;
  // A 2xx response is referenceable in OpenAPI but off-limits here: orank
  // credits only the inline `responses["200"]` schema, so the dedup passes
  // deliberately never hoist one (openapi-dedup-responses.mjs). Offering those
  // bytes would be offering a change the project has already ruled out.
  if (grandparentKey === 'responses' && /^2\d\d$/.test(String(parentKey))) return false;
  if (REF_SLOT_KEYS.has(parentKey) || REF_ARRAY_KEYS.has(parentKey)) return true;
  return REF_ENTRY_CONTAINERS.has(grandparentKey);
}

const escapePointer = (segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

/** Count the operations (method entries) across paths + webhooks. */
function countOperations(spec) {
  let operations = 0;
  for (const container of [spec.paths, spec.webhooks]) {
    for (const pathItem of Object.values(container ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of Object.keys(pathItem)) {
        if (HTTP_METHODS.has(method.toLowerCase())) operations += 1;
      }
    }
  }
  return operations;
}

/** Byte cost of each top-level section, and of each `components.*` bucket. */
export function sectionBreakdown(spec) {
  const sections = [];
  for (const [key, value] of Object.entries(spec)) {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const entries = value && typeof value === 'object' ? Object.keys(value).length : null;
    sections.push({ pointer: `/${escapePointer(key)}`, bytes, entries });
    if (key !== 'components' || !value || typeof value !== 'object') continue;
    for (const [bucket, contents] of Object.entries(value)) {
      sections.push({
        pointer: `/components/${escapePointer(bucket)}`,
        bytes: Buffer.byteLength(JSON.stringify(contents), 'utf8'),
        entries: contents && typeof contents === 'object' ? Object.keys(contents).length : null,
      });
    }
  }
  return sections.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Byte cost of each Operation Object field, summed over every operation.
 *
 * This is where "generated" pressure shows up: a field whose per-operation cost
 * is high is one an injector stamps fleet-wide, and fleet-wide stamps are the
 * structures worth collapsing before hand-written documentation is touched.
 */
export function operationFieldBreakdown(spec) {
  const totals = new Map();
  const operations = countOperations(spec);
  for (const container of [spec.paths, spec.webhooks]) {
    for (const pathItem of Object.values(container ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const [method, op] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method.toLowerCase()) || !op || typeof op !== 'object') continue;
        for (const [field, value] of Object.entries(op)) {
          // + the `"field":` key and its trailing comma, which the field's own
          // presence is equally responsible for. The key is measured in bytes
          // too — a non-ASCII extension field (`x-π`) is longer than its
          // `String#length`, and undercounting keys is the very error this
          // report exists to stop making.
          const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
            + Buffer.byteLength(field, 'utf8') + 4;
          totals.set(field, (totals.get(field) ?? 0) + bytes);
        }
      }
    }
  }
  return [...totals]
    .map(([field, bytes]) => ({
      field,
      bytes,
      bytesPerOperation: operations > 0 ? Math.round(bytes / operations) : null,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Rank the repeated subtrees that are still inline after the existing dedup
 * passes, without double-counting nested repeats.
 *
 * The naive version of this list is wrong in a way that flatters it: a repeated
 * `headers` object and the repeated header entries *inside* it are both
 * repeated, and adding their yields promises bytes that can only be spent once.
 * Candidates are taken greedily from the largest, and a later candidate is
 * dropped when it overlaps an already-selected subtree in EITHER direction —
 * whether its copies sit inside one, or contain one. Containment has to be
 * checked too: a small subtree repeated 30 times outranks the larger structure
 * wrapping three of them, gets selected first, and the wrapper would then be
 * credited its full size including bytes already counted.
 */
export function repeatedStructures(spec, { minBytes = MIN_REPEATED_SUBTREE_BYTES, topN = TOP_N } = {}) {
  const parentOf = new Map();
  const pointerOf = new Map();
  /** @type {Map<string, { occurrences: number, unitBytes: number, nodes: object[] }>} */
  const groups = new Map();

  // Canonical form is built bottom-up so every node is stringified once. Key
  // order does not change a JSON object's byte length, so the canonical
  // string's length is the node's real cost in the artifact.
  //
  // `parentKey`/`grandparentKey` are what decide whether a `$ref` could stand
  // in this node's place; an array passes its own key down so an element of
  // `oneOf` still reads as `oneOf`. `inRawData` marks everything under an
  // `example`/`enum`/`const`/`default`: still serialized, still costs bytes,
  // but not a candidate at any depth.
  const canonical = (node, pointer, parent, parentKey, grandparentKey, inRawData) => {
    if (Array.isArray(node)) {
      parentOf.set(node, parent);
      return `[${node
        .map((child, i) => canonical(child, `${pointer}/${i}`, node, parentKey, grandparentKey, inRawData))
        .join(',')}]`;
    }
    if (node && typeof node === 'object') {
      parentOf.set(node, parent);
      pointerOf.set(node, pointer || '/');
      const serialized = `{${Object.keys(node)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(
          node[k],
          `${pointer}/${escapePointer(k)}`,
          node,
          k,
          parentKey,
          inRawData || RAW_DATA_KEYS.has(k),
        )}`)
        .join(',')}}`;
      const unitBytes = Buffer.byteLength(serialized, 'utf8');
      if (isReferenceablePosition(parentKey, grandparentKey, inRawData) && unitBytes >= minBytes) {
        let group = groups.get(serialized);
        if (!group) {
          group = { occurrences: 0, unitBytes, nodes: [] };
          groups.set(serialized, group);
        }
        group.occurrences += 1;
        group.nodes.push(node);
      }
      return serialized;
    }
    return JSON.stringify(node) ?? 'null';
  };
  // The root document is not a referenceable position, so it starts with no
  // parent or grandparent key and falls out of the allow-list naturally.
  canonical(spec, '', null, null, null, false);

  // Selected nodes, plus every ancestor of one. The first set catches a
  // candidate nested inside a selection; the second catches a candidate that
  // wraps one. Without the second, the wrapper's already-counted inner bytes
  // get promised twice.
  const selectedNodes = new Set();
  const ancestorsOfSelected = new Set();
  const overlapsSelection = (node) => {
    if (ancestorsOfSelected.has(node)) return true;
    let parent = parentOf.get(node);
    while (parent) {
      if (selectedNodes.has(parent)) return true;
      parent = parentOf.get(parent);
    }
    return false;
  };
  const markSelected = (node) => {
    selectedNodes.add(node);
    let parent = parentOf.get(node);
    while (parent && !ancestorsOfSelected.has(parent)) {
      ancestorsOfSelected.add(parent);
      parent = parentOf.get(parent);
    }
  };

  const candidates = [...groups.values()]
    .filter((group) => group.occurrences >= 2 && group.unitBytes > ESTIMATED_REF_BYTES)
    .sort(
      (a, b) =>
        (b.occurrences - 1) * (b.unitBytes - ESTIMATED_REF_BYTES)
        - (a.occurrences - 1) * (a.unitBytes - ESTIMATED_REF_BYTES),
    );

  const selected = [];
  for (const group of candidates) {
    const free = group.nodes.filter((node) => !overlapsSelection(node));
    if (free.length < 2) continue;
    for (const node of free) markSelected(node);
    selected.push({
      // Pointers come from the counted copies, never from the whole group: a
      // row that names occurrences its own count excluded sends the reader to
      // the wrong place.
      pointers: free.slice(0, 3).map((node) => pointerOf.get(node) ?? '/'),
      occurrences: free.length,
      unitBytes: group.unitBytes,
      estimatedRecoverableBytes: (free.length - 1) * (group.unitBytes - ESTIMATED_REF_BYTES),
    });
  }

  selected.sort((a, b) => b.estimatedRecoverableBytes - a.estimatedRecoverableBytes);
  return {
    estimatedRecoverableBytes: selected.reduce((sum, s) => sum + s.estimatedRecoverableBytes, 0),
    groups: selected.length,
    top: selected.slice(0, topN),
  };
}

/**
 * Component schemas still unreachable in the SERVED document.
 *
 * `buildBundle()` already drops these (openapi-drop-unreachable-schemas.mjs),
 * so a healthy report reads zero.
 *
 * This is NOT a regression detector for that transform and must not be read as
 * one: it re-runs the same `unreachableSchemaNames` walk the drop used, so a
 * walk that regressed to "everything is reachable" would delete nothing AND
 * report nothing — the guard would agree with itself. What catches that is
 * `transforms.<name>.engaged` below, which is computed from the transform's own
 * returned counts, and the `>= 150` floor in
 * tests/openapi-unreachable-schemas.test.mjs. This field's job is narrower:
 * surface orphans that a LATER pass reintroduced after the drop ran.
 *
 * `bytes` is exact: the measured difference between the document with and
 * without them, mirroring the transform (which also removes an emptied
 * `components.schemas`), not a sum of parts that ignores separators.
 */
export function unreferencedComponentSchemas(spec) {
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return { count: 0, bytes: 0, names: [] };

  const names = [...unreachableSchemaNames(spec)];
  if (names.length === 0) return { count: 0, bytes: 0, names: [] };

  const trimmed = { ...spec, components: { ...spec.components, schemas: { ...schemas } } };
  for (const name of names) delete trimmed.components.schemas[name];
  if (Object.keys(trimmed.components.schemas).length === 0) delete trimmed.components.schemas;
  const bytes = Buffer.byteLength(JSON.stringify(spec), 'utf8')
    - Buffer.byteLength(JSON.stringify(trimmed), 'utf8');

  return { count: names.length, bytes, names: names.slice(0, TOP_N) };
}

/**
 * Which emit-time transforms actually did work on this bundle.
 *
 * Derived from each transform's OWN returned counts, so it stays true when a
 * transform silently stops engaging — the case a re-derivation from the
 * transformed document cannot see, because a disengaged transform and a
 * document with nothing left to do look identical from the output side.
 */
function transformEngagement(bundle) {
  const engaged = (n) => Number.isFinite(n) && n > 0;
  return {
    errorResponses: { ...bundle.stats, engaged: engaged(bundle.stats?.replacedRefs) },
    chinaProvenanceSchemas: {
      ...bundle.schemaStats,
      engaged: engaged(bundle.schemaStats?.replacedRefs),
    },
    sharedParameters: { ...bundle.paramStats, engaged: engaged(bundle.paramStats?.replacedRefs) },
    unreachableSchemas: {
      ...bundle.unreachableStats,
      engaged: engaged(bundle.unreachableStats?.dropped),
    },
  };
}

/**
 * Turn a built bundle into the capacity report.
 *
 * @param {{ spec: object, bytes: number, stats: object, schemaStats: object,
 *   paramStats: object, unreachableStats: object }} bundle
 */
export function buildCapacityReport(bundle, {
  budgetBytes = SCANNER_BUDGET_BYTES,
  minOperations = MIN_PLAUSIBLE_OPERATIONS,
} = {}) {
  const { spec, bytes } = bundle;
  const operations = countOperations(spec);

  // A bundle with no bytes, or implausibly few operations, is not a healthy
  // artifact that happens to be small — it is a build that produced little or
  // nothing. Reporting "900 KB of headroom" for it would be the exact failure
  // mode this report exists to replace, so it is a measurement failure, never
  // a pass. The floor is what makes this catch a PARTIAL generation; a
  // zero-only check only ever fires on the impossible case.
  if (!(bytes > 0) || operations < minOperations) {
    return {
      schemaVersion: 1,
      artifact: 'public/openapi.json',
      status: 'unmeasured',
      reason: bytes > 0
        ? `the bundle declares only ${operations} operations (floor ${minOperations}) — generation looks partial`
        : `the bundle serialized to ${bytes} bytes — nothing was generated`,
      bytes,
      budgetBytes,
      operations,
    };
  }

  const headroomBytes = budgetBytes - bytes;
  // At least 1: a bundle small enough to round to 0 bytes/operation would make
  // reserveBytes 0, and `reserve-breached` unreachable in both directions.
  const bytesPerOperation = Math.max(1, Math.round(bytes / operations));
  const reserveBytes = bytesPerOperation * RESERVE_OPERATIONS;
  const status = headroomBytes < 0
    ? 'over-budget'
    : headroomBytes < reserveBytes
      ? 'reserve-breached'
      : 'ok';

  const repeated = repeatedStructures(spec);
  return {
    schemaVersion: 1,
    artifact: 'public/openapi.json',
    status,
    bytes,
    budgetBytes,
    headroomBytes,
    headroomPct: Number(((headroomBytes / budgetBytes) * 100).toFixed(3)),
    operations,
    bytesPerOperation,
    operationsRemaining: Math.floor(headroomBytes / bytesPerOperation),
    reserveBytes,
    reserveOperations: RESERVE_OPERATIONS,
    transforms: transformEngagement(bundle),
    sections: sectionBreakdown(spec),
    operationFields: operationFieldBreakdown(spec),
    unreferencedComponentSchemas: unreferencedComponentSchemas(spec),
    repeatedStructures: repeated,
  };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** GitHub-flavoured markdown for the job summary. */
export function formatMarkdown(report) {
  if (report.status === 'unmeasured') {
    return `### OpenAPI bundle capacity\n\n**NOT MEASURED** — ${report.reason}\n`;
  }
  const verdict = {
    ok: 'within budget',
    'reserve-breached': `below the ${report.reserveOperations}-operation reserve`,
    'over-budget': 'OVER BUDGET',
  }[report.status];

  const lines = [
    '### OpenAPI bundle capacity',
    '',
    `\`public/openapi.json\` is **${report.bytes.toLocaleString('en-US')} bytes** of a `
      + `${report.budgetBytes.toLocaleString('en-US')}-byte scanner budget — `
      + `**${report.headroomBytes.toLocaleString('en-US')} bytes free** (${report.headroomPct}%), ${verdict}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Served bytes | ${report.bytes.toLocaleString('en-US')} |`,
    `| Budget | ${report.budgetBytes.toLocaleString('en-US')} |`,
    `| Headroom | ${report.headroomBytes.toLocaleString('en-US')} (${report.headroomPct}%) |`,
    `| Operations | ${report.operations} (${report.bytesPerOperation} bytes each, mean) |`,
    `| Room for | ~${report.operationsRemaining} more operations |`,
    `| Reserve | ${report.reserveBytes.toLocaleString('en-US')} (${report.reserveOperations} operations) |`,
    '',
    '<details><summary>Largest sections</summary>',
    '',
    '| Section | Bytes | Entries |',
    '| --- | --- | --- |',
    ...report.sections.slice(0, 8).map((s) => `| \`${s.pointer}\` | ${s.bytes.toLocaleString('en-US')} | ${s.entries ?? '—'} |`),
    '',
    '</details>',
    '',
    '<details><summary>Reduction candidates (lossless, unspent)</summary>',
    '',
    `- ${report.repeatedStructures.groups} repeated subtrees are still inline: `
      + `**~${kb(report.repeatedStructures.estimatedRecoverableBytes)}** (non-overlapping estimate)`,
    `- Unreachable component schemas remaining: **${report.unreferencedComponentSchemas.count}** `
      + '(the emit-time drop should keep this at 0)',
    '',
    '| Repeated subtree | × | Unit | Est. recoverable |',
    '| --- | --- | --- | --- |',
    ...report.repeatedStructures.top.slice(0, 10).map(
      (r) => `| \`${r.pointers[0]}\` | ${r.occurrences} | ${r.unitBytes} | ${r.estimatedRecoverableBytes.toLocaleString('en-US')} |`,
    ),
    '',
    '</details>',
    '',
    'Plan and rationale: `docs/perf/openapi-bundle-capacity-2026-08-13.md`',
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { json: false, out: null, budgetBytes: SCANNER_BUDGET_BYTES };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--out') {
      const next = rest[++i];
      if (!next || next.startsWith('--')) throw new Error('--out requires a file path');
      args.out = next;
    } else if (arg === '--budget') {
      // What-if lever for local analysis ("how much would we need to cut to sit
      // under 800 KB?"), and the only way to exercise the over-budget exit
      // without a fabricated bundle. It cannot weaken the gate: the gate is
      // tests/openapi-json-dedup.test.mjs, which pins 950,000 literally, and
      // the CI step's exact argument list is pinned in
      // tests/ci-workflow-coverage.test.mts.
      const next = Number(rest[++i]);
      if (!Number.isInteger(next) || next <= 0) throw new Error('--budget requires a positive integer');
      args.budgetBytes = next;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[openapi-capacity] ${err instanceof Error ? err.message : String(err)}`);
    console.error('[openapi-capacity] usage: openapi-capacity-report.mjs [--json] [--out <file>] [--budget <bytes>]');
    process.exit(2);
  }

  let bundle;
  try {
    bundle = buildBundle();
  } catch (err) {
    // Exit 3, not the 1 an unhandled throw would produce: an unparseable or
    // missing bundle is "could not measure", and reporting it as "over budget"
    // sends the next reader hunting for bytes that were never counted.
    console.error(`::error::openapi capacity NOT MEASURED — the bundle could not be built: ${
      err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 3;
    return;
  }

  const report = buildCapacityReport(bundle, { budgetBytes: args.budgetBytes });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (args.out) {
    try {
      writeFileSync(args.out, serialized);
    } catch (err) {
      console.error(`[openapi-capacity] cannot write ${args.out}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  // `process.stdout.write` + `process.exit` truncates a piped write. Every exit
  // below therefore sets `process.exitCode` and returns, letting Node drain
  // stdout before it ends — otherwise the machine-readable report is exactly
  // the thing lost on the failure paths that need it most.
  if (args.json) process.stdout.write(serialized);

  if (process.env.GITHUB_STEP_SUMMARY) {
    // Rendered OUTSIDE the try: only the write is allowed to fail silently. A
    // bug in formatMarkdown is a bug, and swallowing it here would hide it on
    // the one surface that renders it.
    const markdown = formatMarkdown(report);
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    } catch {
      // The summary is a convenience surface. The JSON artifact and the
      // annotations below carry the same numbers, so losing it is not a
      // reason to fail the step.
    }
  }

  if (report.status === 'unmeasured') {
    console.error(`::error::openapi capacity NOT MEASURED — ${report.reason}`);
    process.exitCode = 3;
    return;
  }

  const headline = `public/openapi.json is ${report.bytes} bytes of ${report.budgetBytes} `
    + `(${report.headroomBytes} free, ~${report.operationsRemaining} more operations at `
    + `${report.bytesPerOperation} bytes each)`;

  if (report.status === 'over-budget') {
    console.error(`::error::OVER BUDGET — ${headline}`);
    console.error('[openapi-capacity] extend the dedup passes or drop unreachable schemas; do NOT raise the budget');
    process.exitCode = 1;
    return;
  }
  if (report.status === 'reserve-breached') {
    console.warn(
      `::warning::OpenAPI bundle reserve breached — ${headline}. `
        + `Collapsing the repeated structures still inline would return ~${report.repeatedStructures.estimatedRecoverableBytes} bytes; `
        + 'see docs/perf/openapi-bundle-capacity-2026-08-13.md',
    );
  } else {
    // stderr, not stdout: under `--json` stdout is the machine-readable report
    // and a human line mixed into it makes the artifact unparseable. GitHub
    // reads workflow commands from both streams, so the annotation still lands.
    console.error(`::notice::${headline}`);
  }
  console.error(`[openapi-capacity] ${report.status}: ${headline}`);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
if (invokedDirectly) main();
