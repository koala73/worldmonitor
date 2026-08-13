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

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const SCHEMA_REF_PREFIX = '#/components/schemas/';

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
          // presence is equally responsible for.
          const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + field.length + 4;
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
 * Candidates are taken greedily from the largest, and a later candidate counts
 * only the occurrences that do not already sit inside a selected subtree.
 */
export function repeatedStructures(spec, { minBytes = MIN_REPEATED_SUBTREE_BYTES, topN = TOP_N } = {}) {
  const parentOf = new Map();
  /** @type {Map<string, { occurrences: number, unitBytes: number, nodes: object[], pointers: string[] }>} */
  const groups = new Map();

  // Canonical form is built bottom-up so every node is stringified once. Key
  // order does not change a JSON object's byte length, so the canonical
  // string's length is the node's real cost in the artifact.
  const canonical = (node, pointer, parent) => {
    if (Array.isArray(node)) {
      parentOf.set(node, parent);
      return `[${node.map((child, i) => canonical(child, `${pointer}/${i}`, node)).join(',')}]`;
    }
    if (node && typeof node === 'object') {
      parentOf.set(node, parent);
      const serialized = `{${Object.keys(node)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(node[k], `${pointer}/${escapePointer(k)}`, node)}`)
        .join(',')}}`;
      const unitBytes = Buffer.byteLength(serialized, 'utf8');
      if (unitBytes >= minBytes) {
        let group = groups.get(serialized);
        if (!group) {
          group = { occurrences: 0, unitBytes, nodes: [], pointers: [] };
          groups.set(serialized, group);
        }
        group.occurrences += 1;
        group.nodes.push(node);
        if (group.pointers.length < 3) group.pointers.push(pointer || '/');
      }
      return serialized;
    }
    return JSON.stringify(node) ?? 'null';
  };
  canonical(spec, '', null);

  const insideSelected = (node, selected) => {
    let parent = parentOf.get(node);
    while (parent) {
      if (selected.has(parent)) return true;
      parent = parentOf.get(parent);
    }
    return false;
  };

  const candidates = [...groups.values()]
    .filter((group) => group.occurrences >= 2 && group.unitBytes > ESTIMATED_REF_BYTES)
    .sort(
      (a, b) =>
        (b.occurrences - 1) * (b.unitBytes - ESTIMATED_REF_BYTES)
        - (a.occurrences - 1) * (a.unitBytes - ESTIMATED_REF_BYTES),
    );

  const selectedNodes = new Set();
  const selected = [];
  for (const group of candidates) {
    const free = group.nodes.filter((node) => !insideSelected(node, selectedNodes));
    if (free.length < 2) continue;
    for (const node of free) selectedNodes.add(node);
    selected.push({
      pointers: group.pointers,
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
 * so a healthy report reads zero. It stays in the report as the regression
 * detector for that transform: a non-zero count means the drop stopped
 * engaging — the failure mode where a saving quietly stops being taken and only
 * the budget notices, a year later, from the wrong direction.
 *
 * `bytes` is exact: the measured difference between the document with and
 * without them, not a sum of parts that ignores separators.
 */
export function unreferencedComponentSchemas(spec) {
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return { count: 0, bytes: 0, names: [] };

  const names = [...unreachableSchemaNames(spec)];
  if (names.length === 0) return { count: 0, bytes: 0, names: [] };

  const trimmed = { ...spec, components: { ...spec.components, schemas: { ...schemas } } };
  for (const name of names) delete trimmed.components.schemas[name];
  const bytes = Buffer.byteLength(JSON.stringify(spec), 'utf8')
    - Buffer.byteLength(JSON.stringify(trimmed), 'utf8');

  return { count: names.length, bytes, names: names.slice(0, TOP_N) };
}

/**
 * Turn a built bundle into the capacity report.
 *
 * @param {{ spec: object, bytes: number, stats: object, schemaStats: object, paramStats: object }} bundle
 */
export function buildCapacityReport(bundle, { budgetBytes = SCANNER_BUDGET_BYTES } = {}) {
  const { spec, bytes } = bundle;
  const operations = countOperations(spec);

  // A bundle with no operations, or no bytes, is not a healthy artifact that
  // happens to be small — it is a build that produced nothing. Reporting
  // "941 KB of headroom" for it would be the exact failure mode this report
  // exists to replace, so it is a measurement failure, never a pass.
  if (!(bytes > 0) || operations === 0) {
    return {
      schemaVersion: 1,
      artifact: 'public/openapi.json',
      status: 'unmeasured',
      reason: operations === 0
        ? 'the bundle declares zero operations — nothing was generated'
        : `the bundle serialized to ${bytes} bytes — nothing was generated`,
      bytes,
      budgetBytes,
      operations,
    };
  }

  const headroomBytes = budgetBytes - bytes;
  const bytesPerOperation = Math.round(bytes / operations);
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
    transforms: {
      errorResponses: bundle.stats,
      chinaProvenanceSchemas: bundle.schemaStats,
      sharedParameters: bundle.paramStats,
      unreachableSchemas: bundle.unreachableStats,
    },
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
  const args = { json: false, out: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--out') {
      const next = rest[++i];
      if (!next || next.startsWith('--')) throw new Error('--out requires a file path');
      args.out = next;
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
    console.error('[openapi-capacity] usage: openapi-capacity-report.mjs [--json] [--out <file>]');
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
    process.exit(3);
  }

  const report = buildCapacityReport(bundle);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (args.out) {
    try {
      writeFileSync(args.out, serialized);
    } catch (err) {
      console.error(`[openapi-capacity] cannot write ${args.out}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  if (args.json) process.stdout.write(serialized);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatMarkdown(report)}\n`);
    } catch {
      // The summary is a convenience surface. The JSON artifact and the
      // annotations below carry the same numbers, so losing it is not a
      // reason to fail the step.
    }
  }

  if (report.status === 'unmeasured') {
    console.error(`::error::openapi capacity NOT MEASURED — ${report.reason}`);
    process.exit(3);
  }

  const headline = `public/openapi.json is ${report.bytes} bytes of ${report.budgetBytes} `
    + `(${report.headroomBytes} free, ~${report.operationsRemaining} more operations at `
    + `${report.bytesPerOperation} bytes each)`;

  if (report.status === 'over-budget') {
    console.error(`::error::OVER BUDGET — ${headline}`);
    console.error('[openapi-capacity] extend the dedup passes or drop unreachable schemas; do NOT raise the budget');
    process.exit(1);
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
