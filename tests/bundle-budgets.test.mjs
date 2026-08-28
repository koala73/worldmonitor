import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_TOLERANCE_BYTES,
  DEFAULT_TOLERANCE_PCT,
  TOTAL_TOLERANCE_BYTES,
  TOTAL_TOLERANCE_PCT,
  buildBudgetSnapshot,
  chunkNameFromFileName,
  compareBundleBudgets,
  initialDashboardAssetNames,
  measureDistChunks,
  measureEmbedJs,
  measureProDistChunks,
  validateBudgetSnapshot,
} from '../scripts/bundle-budgets.mjs';

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'bundle-budgets.mjs',
);

const fixtures = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

/** Repeating-pattern content resembling minified JS. */
function chunkContent(bytes) {
  return 'export const x = "worldmonitor bundle budget fixture ";\n'.repeat(Math.ceil(bytes / 56)).slice(0, bytes);
}

function writeDashboardIndex(root, files) {
  const jsFiles = files.filter((name) => name.endsWith('.js'));
  const tags = jsFiles.map((name, index) => index === 0
    ? `<script type="module" src="/assets/${name}"></script>`
    : `<link rel="modulepreload" href="/assets/${name}">`);
  writeFileSync(join(root, 'dashboard.html'), tags.join('\n'));
}

function makeAssetsFixture(files, { distName = 'dashboard.html', writeIndex = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-bundle-budgets-'));
  fixtures.push(root);
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(assets, name), chunkContent(bytes));
  }
  if (writeIndex) writeDashboardIndex(root, Object.keys(files));
  return root;
}

function makeDistFixture(files) {
  return makeAssetsFixture(files);
}

function makeEmbedFixture(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'wm-bundle-budgets-'));
  fixtures.push(root);
  writeFileSync(join(root, 'embed.js'), chunkContent(bytes));
  return root;
}

describe('chunkNameFromFileName', () => {
  test('strips the trailing content hash', () => {
    assert.equal(chunkNameFromFileName('main-DYSz1bMh.js'), 'main');
    assert.equal(chunkNameFromFileName('h3-js-a1B2c3D4.js'), 'h3-js');
    // Hashes are exactly 8 chars and may themselves contain '-'.
    assert.equal(chunkNameFromFileName('_live-webcams-origin-BScNR-MD.js'), '_live-webcams-origin');
  });

  test('rejects non-chunk files', () => {
    assert.equal(chunkNameFromFileName('main-DYSz1bMh.js.br'), null);
    assert.equal(chunkNameFromFileName('main-DYSz1bMh.js.map'), null);
    assert.equal(chunkNameFromFileName('sw.js'), null);
    assert.equal(chunkNameFromFileName('style-Ab12Cd34.css'), null);
  });
});

describe('measureDistChunks', () => {
  test('measures raw bytes per initial dashboard chunk name', () => {
    const dist = makeDistFixture({
      'main-DYSz1bMh.js': 10_000,
      'd3-Ab12Cd34.js': 5_000,
    });
    writeFileSync(join(dist, 'assets', 'main-DYSz1bMh.js.br'), 'not a chunk');
    const measured = measureDistChunks(dist);
    assert.deepEqual(Object.keys(measured.chunks).sort(), ['d3', 'main']);
    assert.equal(measured.chunks.main.raw, 10_000);
    assert.equal(measured.chunks.d3.raw, 5_000);
    assert.equal(measured.total.raw, 15_000);
    assert.deepEqual(initialDashboardAssetNames(dist), ['d3-Ab12Cd34.js', 'main-DYSz1bMh.js']);
  });

  test('aggregates same-name chunks from one build and counts the files', () => {
    // A real full-variant build emits nine distinct index-*.js chunks.
    const dist = makeDistFixture({
      'index-BLxGuKBb.js': 4_000,
      'index-BTEierCQ.js': 6_000,
      'main-DYSz1bMh.js': 10_000,
    });
    const measured = measureDistChunks(dist);
    assert.equal(measured.chunks.index.raw, 10_000);
    assert.equal(measured.chunks.index.files, 2);
    assert.equal(measured.chunks.main.files, 1);
  });

  test('throws when the dashboard index has no JS assets', () => {
    const dist = makeDistFixture({});
    assert.throws(() => measureDistChunks(dist), /no initial JS assets/i);
  });

  test('ignores lazy chunks that are not referenced by the dashboard entry', () => {
    const dist = makeDistFixture({
      'main-DYSz1bMh.js': 10_000,
      'lazy-panel-Ab12Cd34.js': 90_000,
    });
    writeDashboardIndex(dist, ['main-DYSz1bMh.js']);
    const measured = measureDistChunks(dist);
    assert.deepEqual(Object.keys(measured.chunks), ['main']);
    assert.equal(measured.total.raw, 10_000);
  });

  test('an un-hashed .js asset is tracked under its literal name, not silently ignored', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 10_000 });
    writeFileSync(join(dist, 'assets', 'loader.js'), chunkContent(4_000));
    writeDashboardIndex(dist, ['main-DYSz1bMh.js', 'loader.js']);
    const measured = measureDistChunks(dist);
    assert.equal(measured.chunks['loader.js'].raw, 4_000);
    assert.equal(measured.total.raw, 14_000);
  });

  test('a chunk named after an Object.prototype key is measured, not swallowed', () => {
    const dist = makeDistFixture({
      'toString-Ab12Cd34.js': 3_000,
      '__proto__-Ef56Gh78.js': 2_000,
      'main-DYSz1bMh.js': 10_000,
    });
    const measured = measureDistChunks(dist);
    assert.equal(measured.chunks.toString.raw, 3_000);
    assert.equal(measured.chunks.toString.files, 1);
    assert.equal(measured.chunks.__proto__.raw, 2_000);
    assert.equal(measured.chunks.__proto__.files, 1);
    const budget = buildBudgetSnapshot(measured);
    assert.ok(Object.hasOwn(budget.chunks, '__proto__'));
    assert.deepEqual(validateBudgetSnapshot(budget), []);
    assert.equal(compareBundleBudgets(measured, budget).ok, true);
    // And when it appears only in the build, it must be flagged as new.
    const budgetWithout = buildBudgetSnapshot(
      measureDistChunks(makeDistFixture({ 'main-DYSz1bMh.js': 10_000 })),
    );
    assert.ok(
      compareBundleBudgets(measured, budgetWithout).failures.some((f) => f.includes('toString')),
    );
  });
});

describe('measureProDistChunks', () => {
  test('measures every JS asset under dist/pro/assets', () => {
    const dist = makeAssetsFixture(
      {
        'index-BLxGuKBb.js': 120_000,
        'sentry-Ab12Cd34.js': 40_000,
        'lazy-locale-Xx99Yy88.js': 8_000,
      },
      { writeIndex: false },
    );
    const measured = measureProDistChunks(dist);
    assert.deepEqual(Object.keys(measured.chunks).sort(), ['index', 'lazy-locale', 'sentry']);
    assert.equal(measured.total.raw, 168_000);
  });

  test('throws when dist/pro/assets has no JS files', () => {
    const dist = mkdtempSync(join(tmpdir(), 'wm-bundle-budgets-'));
    fixtures.push(dist);
    mkdirSync(join(dist, 'assets'), { recursive: true });
    assert.throws(() => measureProDistChunks(dist), /no JS assets/i);
  });
});

describe('measureEmbedJs', () => {
  test('tracks the dist-root loader as a single chunk', () => {
    const dist = mkdtempSync(join(tmpdir(), 'wm-bundle-budgets-'));
    fixtures.push(dist);
    writeFileSync(join(dist, 'embed.js'), chunkContent(2_048));
    const measured = measureEmbedJs(dist);
    assert.deepEqual(measured.chunks, { 'embed.js': { raw: 2_048, files: 1 } });
    assert.equal(measured.total.raw, 2_048);
  });

  test('throws when embed.js is missing', () => {
    const dist = mkdtempSync(join(tmpdir(), 'wm-bundle-budgets-'));
    fixtures.push(dist);
    assert.throws(() => measureEmbedJs(dist), /cannot read .*embed\.js/i);
  });
});

describe('compareBundleBudgets', () => {
  const budgetFor = (files) => buildBudgetSnapshot(measureDistChunks(makeDistFixture(files)));

  test('clean tree passes', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000, 'd3-Ab12Cd34.js': 60_000 });
    const measured = measureDistChunks(
      makeDistFixture({ 'main-Xx99Yy88.js': 800_000, 'd3-Qq77Rr66.js': 60_000 }),
    );
    const result = compareBundleBudgets(measured, budget);
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
  });

  test('growth within tolerance passes', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000 });
    const measured = measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': 804_000 }));
    assert.equal(compareBundleBudgets(measured, budget).ok, true);
  });

  test('a +50 KB import on a tracked chunk fails, naming the chunk and the total', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000 });
    const measured = measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': 851_200 }));
    const result = compareBundleBudgets(measured, budget);
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes('main') && f.includes('grew')),
      `expected a main growth failure, got: ${JSON.stringify(result.failures)}`,
    );
    assert.ok(
      result.failures.some((f) => f.includes('total')),
      `expected a total failure, got: ${JSON.stringify(result.failures)}`,
    );
  });

  test('shrinking past tolerance warns without blocking and asks for a ratchet re-seed', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000 });
    const measured = measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': 740_000 }));
    const result = compareBundleBudgets(measured, budget);
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.ok(result.warnings.some((warning) => warning.includes('shrank') && warning.includes('bundle:budgets')));
  });

  test('a new untracked chunk fails until the snapshot is regenerated', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000 });
    const measured = measureDistChunks(
      makeDistFixture({ 'main-Xx99Yy88.js': 800_000, 'heavy-dep-Ab12Cd34.js': 90_000 }),
    );
    const result = compareBundleBudgets(measured, budget);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('heavy-dep') && f.includes('not in the budget')));
  });

  test('a changed same-name file count fails even when total bytes are stable', () => {
    const budget = budgetFor({ 'index-BLxGuKBb.js': 4_000, 'index-BTEierCQ.js': 6_000 });
    const measured = measureDistChunks(makeDistFixture({ 'index-Xx99Yy88.js': 10_000 }));
    const result = compareBundleBudgets(measured, budget);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('index') && f.includes('file(s)')));
  });

  test('a budgeted chunk missing from the build fails', () => {
    const budget = budgetFor({ 'main-DYSz1bMh.js': 800_000, 'd3-Ab12Cd34.js': 60_000 });
    const measured = measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': 800_000 }));
    const result = compareBundleBudgets(measured, budget);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('d3') && f.includes('missing')));
  });

  test('growth smeared across chunks, each inside its own slack, trips the tighter total gate', () => {
    // 20 chunks x 30 KB: per-chunk slack is the 2048 B floor, total slack is
    // the 16384 B floor. Grow each chunk by 1.5 KB — every chunk passes its
    // own gate, the +30 KB sum must fail on the total alone.
    const files = {};
    const grown = {};
    for (let i = 0; i < 20; i += 1) {
      files[`chunk${i}-Ab12Cd34.js`] = 30_000;
      grown[`chunk${i}-Xx99Yy88.js`] = 31_500;
    }
    const budget = budgetFor(files);
    const result = compareBundleBudgets(measureDistChunks(makeDistFixture(grown)), budget);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('total')), JSON.stringify(result.failures));
    assert.ok(!result.failures.some((f) => f.startsWith('chunk ')), 'no per-chunk failure expected');
    assert.equal(result.failures.length, 1, JSON.stringify(result.failures));
  });

  test('per-chunk growth fails and shrinkage warns past the slack', () => {
    // budget 100 KB raw: slack = max(2048, 2000) = 2048.
    const budget = budgetFor({ 'main-DYSz1bMh.js': 100_000 });
    const atSlack = (bytes) => compareBundleBudgets(
      measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': bytes })),
      budget,
    );
    const chunkFailures = (r) => r.failures.filter((f) => f.includes('"main"'));
    const chunkWarnings = (r) => r.warnings.filter((warning) => warning.includes('"main"'));
    assert.deepEqual(chunkFailures(atSlack(102_048)), []);
    assert.equal(chunkFailures(atSlack(102_049)).length, 1);
    assert.deepEqual(chunkFailures(atSlack(97_952)), []);
    assert.deepEqual(chunkFailures(atSlack(97_951)), []);
    assert.equal(chunkWarnings(atSlack(97_951)).length, 1);
  });

  test('default tolerance is a floor of bytes or a percentage, whichever is larger', () => {
    assert.equal(DEFAULT_TOLERANCE_PCT, 2);
    assert.equal(DEFAULT_TOLERANCE_BYTES, 2048);
    // A tiny chunk can move by the byte floor even when 2% would be less.
    const budget = budgetFor({ 'tiny-Ab12Cd34.js': 4_000 });
    const measured = measureDistChunks(makeDistFixture({ 'tiny-Xx99Yy88.js': 5_900 }));
    assert.equal(compareBundleBudgets(measured, budget).ok, true);
  });

  test('embed budget rejects loader growth above its 128-byte allowance', () => {
    const dist = makeEmbedFixture(1_956);
    const budget = buildBudgetSnapshot(measureEmbedJs(dist), 'embed');

    writeFileSync(join(dist, 'embed.js'), chunkContent(2_084));
    assert.equal(compareBundleBudgets(measureEmbedJs(dist), budget, 'embed').ok, true);

    writeFileSync(join(dist, 'embed.js'), chunkContent(2_085));
    const result = compareBundleBudgets(measureEmbedJs(dist), budget, 'embed');
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.includes('embed.js') && failure.includes('grew')));
  });
});

describe('validateBudgetSnapshot', () => {
  const goodBudget = () =>
    buildBudgetSnapshot(measureDistChunks(makeDistFixture({ 'main-DYSz1bMh.js': 100_000 })));

  test('a freshly generated snapshot is trustworthy', () => {
    assert.deepEqual(validateBudgetSnapshot(goodBudget()), []);
    assert.equal(TOTAL_TOLERANCE_PCT < DEFAULT_TOLERANCE_PCT, true);
    assert.ok(TOTAL_TOLERANCE_BYTES >= DEFAULT_TOLERANCE_BYTES);
  });

  test('hand-widened tolerance fields are rejected, not obeyed', () => {
    const budget = { ...goodBudget(), tolerancePct: 50 };
    const problems = validateBudgetSnapshot(budget);
    assert.ok(problems.some((p) => p.includes('tolerance')), JSON.stringify(problems));
    assert.equal(compareBundleBudgets(measureDistChunks(makeDistFixture({ 'main-Xx99Yy88.js': 100_000 })), budget).ok, false);
  });

  test('a deleted files field cannot disable the code-splitting guard', () => {
    const budget = goodBudget();
    delete budget.chunks.main.files;
    assert.ok(validateBudgetSnapshot(budget).some((p) => p.includes('files')));
  });

  test('a non-numeric raw cannot NaN-pass the byte gate', () => {
    const budget = goodBudget();
    budget.chunks.main.raw = 'lots';
    assert.ok(validateBudgetSnapshot(budget).length > 0);
  });

  test('a hand-inflated total.raw decoupled from the chunk sum is rejected', () => {
    const budget = goodBudget();
    budget.total.raw += 500_000;
    assert.ok(validateBudgetSnapshot(budget).some((p) => p.includes('total.raw')));
  });

  test('missing chunks/total sections are rejected', () => {
    assert.ok(validateBudgetSnapshot({}).length > 0);
    assert.ok(validateBudgetSnapshot(null).length > 0);
  });
});

describe('bundle-budgets CLI', () => {
  function runCli(args) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  }

  test('--check exits 0 against a budget seeded from the same dist', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const budgetPath = join(dist, 'budget.json');
    const write = runCli(['--dist', dist, '--budget', budgetPath]);
    assert.equal(write.status, 0, write.stderr);
    const check = runCli(['--check', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 0, check.stderr);
  });

  test('--check exits 1 when a chunk grew past tolerance', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const budgetPath = join(dist, 'budget.json');
    assert.equal(runCli(['--dist', dist, '--budget', budgetPath]).status, 0);
    writeFileSync(join(dist, 'assets', 'main-DYSz1bMh.js'), chunkContent(160_000));
    const check = runCli(['--check', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 1);
    assert.ok(check.stderr.includes('grew'), check.stderr);
  });

  test('--check exits 2 when dist is missing — never a silent pass', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const budgetPath = join(dist, 'budget.json');
    assert.equal(runCli(['--dist', dist, '--budget', budgetPath]).status, 0);
    const check = runCli(['--check', '--dist', join(dist, 'nope'), '--budget', budgetPath]);
    assert.equal(check.status, 2);
  });

  test('--check exits 2 when the committed budget is absent', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const check = runCli(['--check', '--dist', dist, '--budget', join(dist, 'absent.json')]);
    assert.equal(check.status, 2);
  });

  test('--check exits 2 on a tampered snapshot (widened tolerance), never silently obeys it', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const budgetPath = join(dist, 'budget.json');
    assert.equal(runCli(['--dist', dist, '--budget', budgetPath]).status, 0);
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    budget.tolerancePct = 50;
    writeFileSync(budgetPath, JSON.stringify(budget));
    writeFileSync(join(dist, 'assets', 'main-DYSz1bMh.js'), chunkContent(110_000));
    const check = runCli(['--check', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 2);
    assert.ok(check.stderr.includes('cannot trust'), check.stderr);
  });

  test('--check exits 2 on a structurally invalid snapshot instead of crashing to exit 1', () => {
    const dist = makeDistFixture({ 'main-DYSz1bMh.js': 100_000 });
    const budgetPath = join(dist, 'budget.json');
    writeFileSync(budgetPath, JSON.stringify({ comment: 'no chunks or total' }));
    const check = runCli(['--check', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 2);
  });

  test('--surface pro seeds and checks against dist/pro/assets', () => {
    const dist = makeAssetsFixture(
      { 'index-BLxGuKBb.js': 50_000, 'vendor-Xx99Yy88.js': 20_000 },
      { writeIndex: false },
    );
    const budgetPath = join(dist, 'budget-pro.json');
    const write = runCli(['--surface', 'pro', '--dist', dist, '--budget', budgetPath]);
    assert.equal(write.status, 0, write.stderr);
    const check = runCli(['--check', '--surface', 'pro', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 0, check.stderr);
  });

  test('--surface embed seeds and checks against dist/embed.js', () => {
    const dist = makeEmbedFixture(3_000);
    const budgetPath = join(dist, 'budget-embed.json');
    const write = runCli(['--surface', 'embed', '--dist', dist, '--budget', budgetPath]);
    assert.equal(write.status, 0, write.stderr);
    const check = runCli(['--check', '--surface', 'embed', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 0, check.stderr);
  });

  test('--surface pro violations name the pro re-seed command', () => {
    const dist = makeAssetsFixture({ 'index-BLxGuKBb.js': 100_000 }, { writeIndex: false });
    const budgetPath = join(dist, 'budget-pro.json');
    assert.equal(runCli(['--surface', 'pro', '--dist', dist, '--budget', budgetPath]).status, 0);
    writeFileSync(join(dist, 'assets', 'index-BLxGuKBb.js'), chunkContent(160_000));

    const check = runCli(['--check', '--surface', 'pro', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 1, check.stderr);
    assert.ok(check.stderr.includes('`npm run bundle:budgets:pro`'), check.stderr);
  });

  test('--surface embed violations name the embed re-seed command', () => {
    const dist = makeEmbedFixture(1_956);
    const budgetPath = join(dist, 'budget-embed.json');
    assert.equal(runCli(['--surface', 'embed', '--dist', dist, '--budget', budgetPath]).status, 0);
    writeFileSync(join(dist, 'embed.js'), chunkContent(2_085));

    const check = runCli(['--check', '--surface', 'embed', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 1, check.stderr);
    assert.ok(check.stderr.includes('`npm run bundle:budgets:embed`'), check.stderr);
  });

  test('--surface embed invalid snapshots name the embed re-seed command', () => {
    const dist = makeEmbedFixture(1_956);
    const budgetPath = join(dist, 'budget-embed.json');
    assert.equal(runCli(['--surface', 'embed', '--dist', dist, '--budget', budgetPath]).status, 0);
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    budget.toleranceBytes = 2_048;
    writeFileSync(budgetPath, JSON.stringify(budget));

    const check = runCli(['--check', '--surface', 'embed', '--dist', dist, '--budget', budgetPath]);
    assert.equal(check.status, 2, check.stderr);
    assert.ok(check.stderr.includes('regenerate it: npm run bundle:budgets:embed'), check.stderr);
  });
});
