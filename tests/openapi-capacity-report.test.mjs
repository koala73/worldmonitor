import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import { buildBundle } from '../scripts/build-openapi-json.mjs';
import {
  ESTIMATED_REF_BYTES,
  RESERVE_OPERATIONS,
  SCANNER_BUDGET_BYTES,
  buildCapacityReport,
  formatMarkdown,
  operationFieldBreakdown,
  repeatedStructures,
  sectionBreakdown,
  unreferencedComponentSchemas,
} from '../scripts/openapi-capacity-report.mjs';

// The <= 950,000-byte guard in tests/openapi-json-dedup.test.mjs only speaks
// the moment it breaks. #4852, the food-stocks operation and the
// billing-verification 503 each crossed the cap and were discovered by a red
// build on whichever PR happened to be last in line. This report is the number
// the guard is silent about on the way there, so the properties worth pinning
// are the ones that would let it lie: measuring bytes the build does not emit,
// reporting a comfortable headroom for a bundle that generated nothing, and
// promising the same bytes twice when repeated structures nest.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportScript = resolve(root, 'scripts/openapi-capacity-report.mjs');

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

describe('buildCapacityReport — budget arithmetic', () => {
  it('measures the bytes the build actually emits, in UTF-8', () => {
    const bundle = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    const report = buildCapacityReport(bundle);
    assert.equal(report.bytes, bundle.bytes);
    assert.equal(report.bytes, Buffer.byteLength(bundle.json, 'utf8'));
    // The distinction is the point: the cap is a body-size cap in bytes, and
    // the bundle's non-ASCII punctuation makes String#length a different — and
    // always smaller — number.
    assert.ok(
      bundle.bytes > bundle.json.length,
      'the bundle carries non-ASCII text, so bytes must exceed UTF-16 code units',
    );
    assert.equal(report.headroomBytes, SCANNER_BUDGET_BYTES - bundle.bytes);
  });

  it('sits inside the budget with the reserve intact', () => {
    // Not a restatement of the guard: this asserts the RESERVE, which the guard
    // does not check. A green guard with a breached reserve is the state #6558
    // was filed from (3,318 bytes left of 950,000).
    const report = buildCapacityReport(buildBundle({ spec: loadUnifiedOpenApiSpec() }));
    assert.equal(
      report.status,
      'ok',
      `capacity is ${report.status}: ${report.headroomBytes} bytes left, reserve is ${report.reserveBytes}`,
    );
  });

  it('pins both directions of the reserve boundary', () => {
    const at = (budgetBytes) =>
      buildCapacityReport(fakeBundle(oneOperationSpec(), 100), { budgetBytes });
    // One operation costing 100 bytes ⇒ reserve = 3 × 100.
    assert.equal(at(400).reserveBytes, 100 * RESERVE_OPERATIONS);
    assert.equal(at(400).status, 'ok', 'headroom exactly equal to the reserve is not a breach');
    assert.equal(at(399).status, 'reserve-breached');
  });

  it('pins both directions of the budget boundary', () => {
    const at = (budgetBytes) =>
      buildCapacityReport(fakeBundle(oneOperationSpec(), 100), { budgetBytes });
    assert.equal(at(100).status, 'reserve-breached', 'zero headroom is still within budget');
    assert.equal(at(100).headroomBytes, 0);
    assert.equal(at(99).status, 'over-budget');
    assert.equal(at(99).headroomBytes, -1);
  });

  it('counts operations across paths and webhooks, and only real HTTP methods', () => {
    const spec = oneOperationSpec();
    spec.webhooks = { ping: { post: { responses: {} }, description: 'not an operation' } };
    const report = buildCapacityReport(fakeBundle(spec, 100), { budgetBytes: 1000 });
    assert.equal(report.operations, 2);
    assert.equal(report.bytesPerOperation, 50);
    assert.equal(report.operationsRemaining, Math.floor(900 / 50));
  });

  it('refuses to call an empty bundle healthy', () => {
    // The dangerous direction. A build that emitted nothing has enormous
    // "headroom", and reporting that as a pass is precisely how a gate goes
    // green while measuring nothing.
    const noOperations = buildCapacityReport(fakeBundle({ openapi: '3.1.0', paths: {} }, 500));
    assert.equal(noOperations.status, 'unmeasured');
    assert.match(noOperations.reason, /zero operations/);

    const noBytes = buildCapacityReport(fakeBundle(oneOperationSpec(), 0));
    assert.equal(noBytes.status, 'unmeasured');
    assert.match(noBytes.reason, /nothing was generated/);

    for (const report of [noOperations, noBytes]) {
      assert.equal(report.headroomBytes, undefined, 'an unmeasured bundle must not publish headroom');
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

  it('escapes path separators so the pointers are valid JSON Pointers', () => {
    const pointers = sectionBreakdown({ 'a/b': { x: 1 } }).map((s) => s.pointer);
    assert.deepEqual(pointers, ['/a~1b'], 'a "/" inside a key must be escaped as ~1');
  });
});

describe('repeatedStructures — no promising the same bytes twice', () => {
  const wrapper = (fill) => ({
    description: fill,
    child: { description: fill, marker: 'inner' },
  });

  it('counts a repeated parent OR its repeated child, never both', () => {
    const fill = 'z'.repeat(200);
    const spec = { a: wrapper(fill), b: wrapper(fill), c: wrapper(fill) };
    const result = repeatedStructures(spec, { minBytes: 64 });

    // The child repeats three times too, but every copy lives inside a parent
    // already selected for hoisting — those bytes can only be spent once.
    assert.equal(result.groups, 1, 'the nested repeat must not be counted separately');
    const [top] = result.top;
    assert.equal(top.occurrences, 3);
    assert.equal(top.estimatedRecoverableBytes, 2 * (top.unitBytes - ESTIMATED_REF_BYTES));
    assert.equal(result.estimatedRecoverableBytes, top.estimatedRecoverableBytes);
  });

  it('still counts a repeat that sits outside every selected subtree', () => {
    const fill = 'z'.repeat(200);
    const loose = { description: fill, marker: 'inner' };
    const spec = { a: wrapper(fill), b: wrapper(fill), c: wrapper(fill), d: loose, e: loose };
    const result = repeatedStructures(spec, { minBytes: 64 });
    assert.equal(result.groups, 2);
    assert.equal(result.top[1].occurrences, 2, 'only the two free copies count');
  });

  it('ignores subtrees too small to be worth a $ref, and singletons', () => {
    const spec = { a: { t: 'string' }, b: { t: 'string' }, c: { description: 'q'.repeat(300) } };
    assert.deepEqual(repeatedStructures(spec), { estimatedRecoverableBytes: 0, groups: 0, top: [] });
  });

  it('finds real repetition left in the served bundle', () => {
    // Vacuity guard: a walk that silently visits nothing would satisfy every
    // assertion above while reporting an empty reduction plan forever.
    const { spec } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    const result = repeatedStructures(spec);
    assert.ok(result.groups > 20, `expected repeated structure in a generated spec, got ${result.groups}`);
    assert.ok(result.estimatedRecoverableBytes > 10_000, `only ${result.estimatedRecoverableBytes} bytes ranked`);
    assert.ok(result.top.length > 0 && result.top[0].pointers.length > 0);
    for (let i = 1; i < result.top.length; i++) {
      assert.ok(result.top[i - 1].estimatedRecoverableBytes >= result.top[i].estimatedRecoverableBytes);
    }
  });
});

describe('unreferencedComponentSchemas — the drop’s regression detector', () => {
  it('reads zero on the served bundle, because buildBundle already dropped them', () => {
    const { spec } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    assert.deepEqual(unreferencedComponentSchemas(spec), { count: 0, bytes: 0, names: [] });
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
});

describe('formatMarkdown', () => {
  it('leads with the numbers a reviewer needs and never hides an unmeasured run', () => {
    const report = buildCapacityReport(buildBundle({ spec: loadUnifiedOpenApiSpec() }));
    const markdown = formatMarkdown(report);
    assert.match(markdown, /OpenAPI bundle capacity/);
    assert.ok(markdown.includes(report.bytes.toLocaleString('en-US')));
    assert.ok(markdown.includes(report.headroomBytes.toLocaleString('en-US')));
    // The plan path is pointed at from the job summary and the CI annotation,
    // so a rename that leaves those strings behind sends every future reader to
    // a 404 without anything going red.
    const planPath = 'docs/perf/openapi-bundle-capacity-2026-08-13.md';
    assert.ok(markdown.includes(planPath));
    assert.ok(existsSync(resolve(root, planPath)), `${planPath} must exist — the report links to it`);

    const dead = formatMarkdown(buildCapacityReport(fakeBundle({ openapi: '3.1.0', paths: {} }, 500)));
    assert.match(dead, /NOT MEASURED/);
    assert.ok(!/within budget/.test(dead), 'an unmeasured run must not read as a pass');
  });
});

describe('CLI', () => {
  it('writes the report to --out, stdout and the job summary, and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-openapi-capacity-'));
    const outPath = join(dir, 'capacity.json');
    const summaryPath = join(dir, 'summary.md');

    const run = spawnSync('node', [reportScript, '--json', '--out', outPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });

    assert.equal(run.status, 0, run.stderr);
    // stdout must be the report and NOTHING else — a human line mixed in is
    // what makes a "machine-readable" artifact unparseable downstream.
    const fromStdout = JSON.parse(run.stdout);
    assert.equal(fromStdout.schemaVersion, 1);
    assert.equal(fromStdout.artifact, 'public/openapi.json');
    assert.equal(fromStdout.budgetBytes, SCANNER_BUDGET_BYTES);
    assert.equal(readFileSync(outPath, 'utf8'), run.stdout);
    assert.match(readFileSync(summaryPath, 'utf8'), /OpenAPI bundle capacity/);
    // The annotation is the surface a reviewer sees without opening artifacts.
    assert.match(run.stderr, /::(notice|warning)::/);
  });

  it('exits 2 on misuse rather than reporting a number it did not measure', () => {
    assert.throws(
      () => execFileSync('node', [reportScript, '--nope'], { cwd: root, stdio: 'pipe' }),
      (err) => err.status === 2,
    );
    assert.throws(
      () => execFileSync('node', [reportScript, '--out'], { cwd: root, stdio: 'pipe' }),
      (err) => err.status === 2,
    );
  });
});
