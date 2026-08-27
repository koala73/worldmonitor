import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import { buildBundle } from '../scripts/build-openapi-json.mjs';
import {
  ESTIMATED_REF_BYTES,
  MIN_PLAUSIBLE_OPERATIONS,
  RESERVE_OPERATIONS,
  SCANNER_BUDGET_BYTES,
  buildCapacityReport,
  formatMarkdown,
  operationFieldBreakdown,
  repeatedStructures,
  sectionBreakdown,
  unreferencedComponentSchemas,
} from '../scripts/openapi-capacity-report.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

// The <= 950,000-byte guard in tests/openapi-json-dedup.test.mjs only speaks the
// moment it breaks. #4852, the food-stocks operation and the
// billing-verification 503 each crossed the cap and were discovered by a red
// build on whichever PR happened to be last in line. This report is the number
// the guard is silent about on the way there, so the properties worth pinning
// are the ones that would let it lie: measuring bytes the build does not emit,
// reporting a comfortable headroom for a bundle that generated almost nothing,
// and promising the same bytes twice when repeated structures nest.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportScript = resolve(root, 'scripts/openapi-capacity-report.mjs');
const buildScript = resolve(root, 'scripts/build-openapi-json.mjs');
const planPath = 'docs/perf/openapi-bundle-capacity-2026-08-13.md';

// One build of the real bundle for every test that needs it. The source YAML is
// 2.6 MB and each build re-walks the whole document; the sibling
// tests/openapi-json-dedup.test.mjs hoists its fixture for the same reason.
const realBundle = buildBundle({ spec: loadUnifiedOpenApiSpec() });
const realReport = buildCapacityReport(realBundle);

/** A bundle shaped like buildBundle()'s return, with the bytes we want to test. */
const fakeBundle = (spec, bytes) => ({
  spec,
  bytes,
  stats: { hoisted: 0, replacedRefs: 0 },
  schemaStats: { compared: 0, replacedRefs: 0 },
  paramStats: { hoisted: 0, replacedRefs: 0 },
  unreachableStats: { dropped: 0, bytesFreed: 0, names: [] },
});

const oneOperationSpec = () => ({
  openapi: '3.1.0',
  paths: { '/a': { get: { responses: { 200: { description: 'ok' } } }, summary: 'not an operation' } },
});

/** Synthetic spec with `count` operations, for the plausibility floor. */
const nOperationSpec = (count) => {
  const paths = {};
  for (let i = 0; i < count; i++) paths[`/p${i}`] = { get: { responses: { 200: { description: 'ok' } } } };
  return { openapi: '3.1.0', paths };
};

describe('buildCapacityReport — budget arithmetic', () => {
  it('measures the bytes the build actually emits, in UTF-8', () => {
    assert.equal(realReport.bytes, realBundle.bytes);
    assert.equal(realReport.bytes, Buffer.byteLength(realBundle.json, 'utf8'));
    // The distinction is the point: the cap is a body-size cap in bytes, and
    // the bundle's non-ASCII punctuation makes String#length a different — and
    // always smaller — number.
    assert.ok(
      realBundle.bytes > realBundle.json.length,
      'the bundle carries non-ASCII text, so bytes must exceed UTF-16 code units',
    );
    assert.equal(realReport.headroomBytes, SCANNER_BUDGET_BYTES - realBundle.bytes);
  });

  it('sits inside the budget with the reserve intact', () => {
    // Not a restatement of the guard: this asserts the RESERVE, which the guard
    // does not check. A green guard with a breached reserve is the state #6558
    // was filed from (3,318 bytes left of 950,000).
    assert.equal(
      realReport.status,
      'ok',
      `capacity is ${realReport.status}: ${realReport.headroomBytes} bytes left, reserve is ${realReport.reserveBytes}`,
    );
  });

  it('pins both directions of the reserve boundary', () => {
    const at = (budgetBytes) =>
      buildCapacityReport(fakeBundle(oneOperationSpec(), 100), { budgetBytes, minOperations: 1 });
    // One operation costing 100 bytes ⇒ reserve = 3 × 100.
    assert.equal(at(400).reserveBytes, 100 * RESERVE_OPERATIONS);
    assert.equal(at(400).status, 'ok', 'headroom exactly equal to the reserve is not a breach');
    assert.equal(at(399).status, 'reserve-breached');
  });

  it('pins both directions of the budget boundary', () => {
    const at = (budgetBytes) =>
      buildCapacityReport(fakeBundle(oneOperationSpec(), 100), { budgetBytes, minOperations: 1 });
    assert.equal(at(100).status, 'reserve-breached', 'zero headroom is still within budget');
    assert.equal(at(100).headroomBytes, 0);
    assert.equal(at(99).status, 'over-budget');
    assert.equal(at(99).headroomBytes, -1);
  });

  it('keeps the reserve reachable when the mean operation rounds toward zero', () => {
    // bytesPerOperation floors at 1; without that, reserveBytes is 0 and
    // `reserve-breached` becomes unreachable from both sides.
    const report = buildCapacityReport(fakeBundle(nOperationSpec(100), 10), { budgetBytes: 1000 });
    assert.ok(report.bytesPerOperation >= 1);
    assert.ok(report.reserveBytes > 0, 'a zero reserve can never be breached');
  });

  it('counts operations across paths and webhooks, and only real HTTP methods', () => {
    const spec = oneOperationSpec();
    spec.webhooks = { ping: { post: { responses: {} }, description: 'not an operation' } };
    const report = buildCapacityReport(fakeBundle(spec, 100), { budgetBytes: 1000, minOperations: 1 });
    assert.equal(report.operations, 2);
    assert.equal(report.bytesPerOperation, 50);
    assert.equal(report.operationsRemaining, Math.floor(900 / 50));
  });

  it('refuses to call an empty or partial bundle healthy', () => {
    // The dangerous direction. A build that emitted little or nothing has
    // enormous "headroom", and reporting that as a pass is precisely how a gate
    // goes green while measuring nothing.
    const noBytes = buildCapacityReport(fakeBundle(nOperationSpec(200), 0));
    assert.equal(noBytes.status, 'unmeasured');
    assert.match(noBytes.reason, /nothing was generated/);

    // The PLAUSIBLE failure, which a zero-only check cannot see: a codegen or
    // injector change that emits a handful of operations instead of 219.
    const partial = buildCapacityReport(fakeBundle(nOperationSpec(5), 4000));
    assert.equal(partial.status, 'unmeasured');
    assert.match(partial.reason, /only 5 operations/);

    for (const report of [noBytes, partial]) {
      assert.equal(report.headroomBytes, undefined, 'an unmeasured bundle must not publish headroom');
    }
  });

  it('puts the real bundle far above the plausibility floor', () => {
    // Guards the floor from the other side: a floor set above the real
    // operation count would make every run unmeasured.
    assert.ok(
      realReport.operations >= MIN_PLAUSIBLE_OPERATIONS * 2,
      `only ${realReport.operations} operations against a ${MIN_PLAUSIBLE_OPERATIONS} floor`,
    );
  });

  it('reports transform engagement from each transform’s own counts', () => {
    // Derived from the returned stats, not re-derived from the transformed
    // document: a disengaged transform and a document with nothing left to do
    // are indistinguishable from the output side.
    for (const [name, entry] of Object.entries(realReport.transforms)) {
      assert.equal(entry.engaged, true, `${name} did no work on the real bundle`);
    }
    const idle = buildCapacityReport(fakeBundle(nOperationSpec(200), 4000)).transforms;
    for (const [name, entry] of Object.entries(idle)) {
      assert.equal(entry.engaged, false, `${name} must report disengagement`);
    }
  });
});

describe('contributor breakdowns', () => {
  it('ranks sections and expands the components buckets', () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/a': { get: { responses: {} } } },
      components: { schemas: { A: { type: 'string' } }, parameters: { P: { name: 'p' } } },
    };
    const sections = sectionBreakdown(spec);
    const pointers = sections.map((s) => s.pointer);
    assert.ok(pointers.includes('/components/schemas'));
    assert.ok(pointers.includes('/components/parameters'));
    for (let i = 1; i < sections.length; i++) {
      assert.ok(sections[i - 1].bytes >= sections[i].bytes, 'sections must be ranked by bytes');
    }
    assert.equal(sections.find((s) => s.pointer === '/components/schemas').entries, 1);
  });

  it('attributes operation-field cost per operation, not per document', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/a': { get: { description: 'x'.repeat(100) } },
        '/b': { get: { description: 'y'.repeat(100) } },
      },
    };
    const [description] = operationFieldBreakdown(spec);
    assert.equal(description.field, 'description');
    assert.ok(description.bytes > 200);
    assert.equal(description.bytesPerOperation, Math.round(description.bytes / 2));
  });

  it('measures a non-ASCII field key in bytes, not UTF-16 code units', () => {
    // The same error class the whole report exists to stop making, one level
    // down: `field.length` undercounts every multi-byte key.
    const spec = { paths: { '/a': { get: { 'x-π': 'v' } } } };
    const [field] = operationFieldBreakdown(spec);
    assert.equal(field.field, 'x-π');
    assert.equal(field.bytes, Buffer.byteLength(JSON.stringify('v'), 'utf8') + Buffer.byteLength('x-π', 'utf8') + 4);
  });

  it('escapes path separators so the pointers are valid JSON Pointers', () => {
    const pointers = sectionBreakdown({ 'a/b': { x: 1 } }).map((s) => s.pointer);
    assert.deepEqual(pointers, ['/a~1b'], 'a "/" inside a key must be escaped as ~1');
  });

  it('charges webhook operations too, not only paths', () => {
    // countOperations walks paths AND webhooks; a field breakdown that walked
    // only paths would divide real bytes by an inflated operation count.
    const spec = {
      paths: { '/a': { get: { description: 'x'.repeat(100) } } },
      webhooks: { ping: { post: { description: 'y'.repeat(100) } } },
    };
    const [description] = operationFieldBreakdown(spec);
    assert.equal(description.bytes > 200, true, 'both operations must be counted');
    assert.equal(description.bytesPerOperation, Math.round(description.bytes / 2));
  });
});

describe('repeatedStructures — no promising the same bytes twice', () => {
  // Fixtures use real OpenAPI positions, because the estimate is only allowed
  // to count places a `$ref` could actually go.
  const schemaSpec = (properties) => ({ components: { schemas: { S: { properties } } } });

  it('counts a repeated parent OR its repeated child, never both (parent wins first)', () => {
    const fill = 'z'.repeat(200);
    const properties = {};
    for (let i = 0; i < 3; i++) {
      properties[`w${i}`] = { description: fill, properties: { inner: { description: fill, type: 'string' } } };
    }
    const result = repeatedStructures(schemaSpec(properties), { minBytes: 64 });

    assert.equal(result.groups, 1, 'the nested repeat must not be counted separately');
    const [top] = result.top;
    assert.equal(top.occurrences, 3);
    assert.equal(top.estimatedRecoverableBytes, 2 * (top.unitBytes - ESTIMATED_REF_BYTES));
    assert.equal(result.estimatedRecoverableBytes, top.estimatedRecoverableBytes);
  });

  it('counts a repeated parent OR its repeated child, never both (child wins first)', () => {
    // The direction an ancestors-only filter misses. The child repeats 30 times
    // and outranks the wrapper, so it is selected first; the wrapper then looks
    // "free" because none of its copies sits INSIDE a selection — each one
    // CONTAINS one. Crediting it re-sells bytes already counted.
    const child = () => ({ description: 'c'.repeat(80), type: 'string' });
    const properties = {};
    for (let i = 0; i < 27; i++) properties[`f${i}`] = child();
    for (let i = 0; i < 3; i++) {
      properties[`w${i}`] = { description: 'p'.repeat(300), properties: { inner: child() } };
    }

    const result = repeatedStructures(schemaSpec(properties), { minBytes: 64 });
    assert.equal(result.groups, 1, 'the wrapper overlaps the already-counted children');
    assert.equal(result.top[0].occurrences, 30);
    assert.equal(
      result.estimatedRecoverableBytes,
      29 * (result.top[0].unitBytes - ESTIMATED_REF_BYTES),
    );
  });

  it('publishes pointers that name occurrences the entry actually counted', () => {
    const fill = 'z'.repeat(200);
    const inner = () => ({ description: fill, type: 'string' });
    const properties = {};
    for (let i = 0; i < 3; i++) {
      properties[`w${i}`] = { description: fill, properties: { inner: inner() } };
    }
    properties.d = inner();
    properties.e = inner();

    const result = repeatedStructures(schemaSpec(properties), { minBytes: 64 });
    assert.equal(result.groups, 2);

    const free = result.top.find((r) => r.occurrences === 2);
    assert.ok(free, 'the two copies outside the selected wrappers form their own entry');
    // A pointer naming an excluded copy would send the reader to a location the
    // count did not include.
    for (const pointer of free.pointers) {
      assert.ok(
        /\/properties\/(d|e)$/.test(pointer),
        `${pointer} is not one of the counted occurrences`,
      );
    }
  });

  it('does not price a container map, or a Media Type Object, as one hoistable unit', () => {
    // `responses.200.headers` is a Map[string, Header | Reference]: each ENTRY
    // can become a $ref, the map cannot. `content['application/json']` is a
    // Media Type Object, where OpenAPI 3.1 allows no Reference at all.
    const header = () => ({ description: 'h'.repeat(120), schema: { type: 'string' } });
    const mediaType = () => ({ schema: { description: 'm'.repeat(120), type: 'object' } });
    const response = () => ({ headers: { A: header(), B: header() }, content: { 'application/json': mediaType() } });
    const spec = {
      paths: {
        '/a': { get: { responses: { 200: response() } } },
        '/b': { get: { responses: { 200: response() } } },
      },
    };
    const result = repeatedStructures(spec, { minBytes: 64 });
    for (const entry of result.top) {
      for (const pointer of entry.pointers) {
        assert.ok(!pointer.endsWith('/headers'), `the headers MAP is not referenceable: ${pointer}`);
        assert.ok(!pointer.endsWith('/application~1json'), `a Media Type Object is not referenceable: ${pointer}`);
      }
    }
    assert.ok(result.groups > 0, 'the individual header entries and schemas are still candidates');
  });

  it('never offers a 2xx response, which must stay inline for the scanner', () => {
    const body = () => ({ description: 'r'.repeat(200), content: { 'application/json': { schema: { type: 'object' } } } });
    const spec = {
      paths: {
        '/a': { get: { responses: { 200: body(), 503: body() } } },
        '/b': { get: { responses: { 200: body(), 503: body() } } },
      },
    };
    const result = repeatedStructures(spec, { minBytes: 64 });
    for (const entry of result.top) {
      for (const pointer of entry.pointers) {
        assert.ok(!/\/responses\/2\d\d$/.test(pointer), `2xx responses stay inline: ${pointer}`);
      }
    }
    // The non-2xx twin is still fair game, so this is not vacuous.
    assert.ok(
      result.top.some((entry) => entry.pointers.some((p) => p.endsWith('/responses/503'))),
      'the repeated 503 body is a legitimate candidate',
    );
  });

  it('does not price repeated example payloads, which no $ref can replace', () => {
    const payload = { company: { name: 'x'.repeat(200), id: 'abc' } };
    const spec = {
      paths: {
        '/a': { post: { responses: { 503: { content: { 'application/json': { example: structuredClone(payload) } } } } } },
        '/b': { post: { responses: { 503: { content: { 'application/json': { example: structuredClone(payload) } } } } } },
      },
    };
    // The repeated 503 wrapper is a candidate; the example payload inside it is
    // not, at any depth — an example that repeats is a documentation choice,
    // not repetition a component can absorb.
    const result = repeatedStructures(spec, { minBytes: 64 });
    for (const entry of result.top) {
      for (const pointer of entry.pointers) {
        assert.ok(!pointer.includes('/example'), `example payloads are not candidates: ${pointer}`);
      }
    }
  });

  it('ignores subtrees too small to be worth a $ref, and singletons', () => {
    const spec = schemaSpec({ a: { t: 'string' }, b: { t: 'string' }, c: { description: 'q'.repeat(300) } });
    assert.deepEqual(repeatedStructures(spec), { estimatedRecoverableBytes: 0, groups: 0, top: [] });
  });

  it('finds real repetition left in the served bundle', () => {
    // Vacuity guard: a walk that silently visits nothing would satisfy every
    // assertion above while reporting an empty reduction plan forever.
    const result = realReport.repeatedStructures;
    assert.ok(result.groups > 20, `expected repeated structure in a generated spec, got ${result.groups}`);
    assert.ok(result.estimatedRecoverableBytes > 10_000, `only ${result.estimatedRecoverableBytes} bytes ranked`);
    assert.ok(result.top.length > 0 && result.top[0].pointers.length > 0);
    for (let i = 1; i < result.top.length; i++) {
      assert.ok(result.top[i - 1].estimatedRecoverableBytes >= result.top[i].estimatedRecoverableBytes);
    }
  });
});

describe('unreferencedComponentSchemas', () => {
  it('reads zero on the served bundle, because buildBundle already dropped them', () => {
    assert.deepEqual(unreferencedComponentSchemas(realBundle.spec), { count: 0, bytes: 0, names: [] });
  });

  it('reports the exact byte cost when orphans are present', () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/a': { get: { responses: { 200: { schema: { $ref: '#/components/schemas/Used' } } } } } },
      components: { schemas: { Used: { type: 'object' }, Orphan: { description: 'x'.repeat(300) } } },
    };
    const before = Buffer.byteLength(JSON.stringify(spec), 'utf8');
    const result = unreferencedComponentSchemas(spec);
    assert.equal(result.count, 1);
    assert.deepEqual(result.names, ['Orphan']);
    delete spec.components.schemas.Orphan;
    assert.equal(result.bytes, before - Buffer.byteLength(JSON.stringify(spec), 'utf8'));
  });

  it('mirrors the transform when every schema is an orphan', () => {
    // The transform deletes an emptied `components.schemas`; a trimmed copy that
    // keeps `"schemas":{}` undercounts the saving by those bytes.
    const spec = {
      openapi: '3.1.0',
      paths: {},
      components: { schemas: { Orphan: { description: 'x'.repeat(200) } } },
    };
    const before = Buffer.byteLength(JSON.stringify(spec), 'utf8');
    const result = unreferencedComponentSchemas(spec);
    delete spec.components.schemas;
    assert.equal(result.bytes, before - Buffer.byteLength(JSON.stringify(spec), 'utf8'));
  });
});

describe('formatMarkdown', () => {
  it('leads with the numbers a reviewer needs', () => {
    const markdown = formatMarkdown(realReport);
    assert.match(markdown, /OpenAPI bundle capacity/);
    assert.ok(markdown.includes(realReport.bytes.toLocaleString('en-US')));
    assert.ok(markdown.includes(realReport.headroomBytes.toLocaleString('en-US')));
    assert.match(markdown, /within budget/);
    // The plan path is pointed at from the job summary and the CI annotation,
    // so a rename that leaves those strings behind sends every future reader to
    // a 404 without anything going red.
    assert.ok(markdown.includes(planPath));
    assert.ok(existsSync(resolve(root, planPath)), `${planPath} must exist — the report links to it`);
  });

  it('renders every status verdict, and never makes an unmeasured run read as a pass', () => {
    const at = (budgetBytes) =>
      formatMarkdown(buildCapacityReport(fakeBundle(oneOperationSpec(), 100), { budgetBytes, minOperations: 1 }));
    assert.match(at(399), /below the 3-operation reserve/);
    assert.match(at(99), /OVER BUDGET/);

    const dead = formatMarkdown(buildCapacityReport(fakeBundle(nOperationSpec(200), 0)));
    assert.match(dead, /NOT MEASURED/);
    assert.ok(!/within budget/.test(dead), 'an unmeasured run must not read as a pass');
  });
});

describe('CLI', () => {
  const run = (args, env = {}) =>
    spawnSync('node', [reportScript, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('writes the report to --out, stdout and the job summary, and exits 0', () => {
    const dir = createTempDir('wm-openapi-capacity-');
    const outPath = join(dir, 'capacity.json');
    const summaryPath = join(dir, 'summary.md');

    const result = run(['--json', '--out', outPath], { GITHUB_STEP_SUMMARY: summaryPath });

    assert.equal(result.status, 0, result.stderr);
    // stdout must be the report and NOTHING else — a human line mixed in is
    // what makes a "machine-readable" artifact unparseable downstream.
    const fromStdout = JSON.parse(result.stdout);
    assert.equal(fromStdout.schemaVersion, 1);
    assert.equal(fromStdout.artifact, 'public/openapi.json');
    assert.equal(fromStdout.budgetBytes, SCANNER_BUDGET_BYTES);
    assert.equal(readFileSync(outPath, 'utf8'), result.stdout);
    assert.match(readFileSync(summaryPath, 'utf8'), /OpenAPI bundle capacity/);
    // The annotation is the surface a reviewer sees without opening artifacts.
    assert.match(result.stderr, /::(notice|warning)::/);
  });

  it('exits 1 and still emits a complete report when the artifact is over budget', () => {
    // The single most important contract in the script: the over-budget exit.
    // `--budget` is the only way to reach it without fabricating a bundle, and
    // the report must survive the failing exit intact — `process.exit` after an
    // unflushed stdout write is how a piped consumer loses exactly the payload
    // it needed.
    const result = run(['--json', '--budget', '1000']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'over-budget');
    assert.equal(report.budgetBytes, 1000);
    assert.ok(report.headroomBytes < 0);
    assert.match(result.stderr, /::error::OVER BUDGET/);
    assert.match(result.stderr, /do NOT raise the budget/);
  });

  it('exits 3 rather than 1 when the bundle cannot be built at all', () => {
    // "Could not measure" must never be reported as "over budget" — that sends
    // the next reader hunting for bytes nobody counted.
    const result = run([], { OPENAPI_YAML_PATH: join(tmpdir(), 'wm-no-such-bundle.yaml') });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /NOT MEASURED/);
  });

  it('warns without failing when the reserve is breached', () => {
    // The advisory band, and the only path that prints the plan-doc pointer.
    // A budget just above the current size leaves positive headroom below the
    // three-operation reserve.
    const budget = realBundle.bytes + 1900;
    const result = run(['--budget', String(budget)]);
    assert.equal(result.status, 0, 'a breached reserve advises, it does not fail the build');
    assert.match(result.stderr, /::warning::OpenAPI bundle reserve breached/);
    assert.match(result.stderr, /docs\/perf\/openapi-bundle-capacity-2026-08-13\.md/);
  });

  it('exits 2 when --out cannot be written', () => {
    const result = run(['--out', tmpdir()]); // a directory, not a file
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot write/);
  });

  it('exits 2 on misuse rather than reporting a number it did not measure', () => {
    for (const args of [['--nope'], ['--out'], ['--budget', 'x'], ['--budget', '-1']]) {
      assert.equal(run(args).status, 2, `${args.join(' ')} must be a usage error`);
    }
  });
});

describe('build-openapi-json CLI', () => {
  it('writes public/openapi.json when run directly, at the byte count the report publishes', () => {
    // Every consumer of the budget now measures buildBundle() in memory, so
    // without this nothing observes the file the world actually fetches — and
    // the CLI entry is guarded by a predicate that could stop matching.
    const result = spawnSync('node', [buildScript], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const artifact = resolve(root, 'public/openapi.json');
    assert.ok(existsSync(artifact), 'the build must write the artifact');
    assert.equal(statSync(artifact).size, realBundle.bytes);
    assert.match(result.stdout, /dropped \d+ unreachable schemas/);
  });

  it('writes nothing when the module is merely imported', () => {
    // The whole point of the invokedDirectly guard: the capacity report and
    // three test files import this module for measurement. If the guard stopped
    // matching, every import would rewrite the served artifact as a side
    // effect. Asserted through the log line main() prints, so the check itself
    // cannot disturb the file it is protecting.
    const probe = spawnSync(
      'node',
      ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(buildScript).href)}; console.log('IMPORTED');`],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), 'IMPORTED');
    assert.ok(!/build-openapi-json: wrote/.test(probe.stdout), 'importing must not run main()');
  });

  it('refuses a source that is not an OpenAPI document', () => {
    assert.throws(() => buildBundle({ spec: {} }), /not a valid OpenAPI document/);
    assert.throws(() => buildBundle({ spec: { openapi: 3.1 } }), /not a valid OpenAPI document/);
  });

  it('the guard and the build agree byte-for-byte across two YAML parsers', () => {
    // The report's central claim is that it measures "the same call that writes
    // the artifact". The CLI path parses with the `yaml` package; the tests pass
    // a js-yaml parse in through the cached loader. If those two documents ever
    // differed, the guard would be guarding a document nobody serves.
    const fromDisk = buildBundle();
    assert.equal(fromDisk.bytes, realBundle.bytes);
    assert.equal(fromDisk.json, realBundle.json);
  });
});
