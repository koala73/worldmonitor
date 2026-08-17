import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const workflowPath = resolve(repoRoot, '.github/workflows/test.yml');
const guardModuleUrl = pathToFileURL(resolve(repoRoot, 'tests/_lib/built-output-guard.mjs')).href;

const guardProbeSource = [
  "import { describe, it } from 'node:test';",
  "import { writeFileSync } from 'node:fs';",
  `import { guardBuiltOutput, shouldSkipBuiltOutput } from ${JSON.stringify(guardModuleUrl)};`,
  "const dashboardHtml = process.env.WM_DASHBOARD_GUARD_DASHBOARD;",
  "const expectBuiltOutput = process.env.WM_EXPECT_BUILT_OUTPUT === '1';",
  "writeFileSync(process.env.WM_DASHBOARD_GUARD_LOADED, 'loaded');",
  "describe('built-output guard probe', { skip: shouldSkipBuiltOutput(dashboardHtml, expectBuiltOutput) }, () => {",
  "  writeFileSync(process.env.WM_DASHBOARD_GUARD_SUITE, 'entered');",
  "  guardBuiltOutput(dashboardHtml, expectBuiltOutput);",
  "  it('executes the built-output assertion', () => {",
  "    writeFileSync(process.env.WM_DASHBOARD_GUARD_ASSERTION, 'ran');",
  "  });",
  "});",
].join('\n');

function runGuardProbe(expectBuiltOutput) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'worldmonitor-built-output-guard-'));
  const probePath = join(fixtureRoot, 'guard-probe.test.mjs');
  const dashboardHtml = join(fixtureRoot, 'dist', 'dashboard.html');
  const loadedMarker = join(fixtureRoot, 'loaded');
  const suiteMarker = join(fixtureRoot, 'suite');
  const assertionMarker = join(fixtureRoot, 'assertion');

  try {
    writeFileSync(probePath, guardProbeSource);
    const env = {
      ...process.env,
      WM_DASHBOARD_GUARD_DASHBOARD: dashboardHtml,
      WM_DASHBOARD_GUARD_LOADED: loadedMarker,
      WM_DASHBOARD_GUARD_SUITE: suiteMarker,
      WM_DASHBOARD_GUARD_ASSERTION: assertionMarker,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (expectBuiltOutput) env.WM_EXPECT_BUILT_OUTPUT = '1';
    else delete env.WM_EXPECT_BUILT_OUTPUT;

    const result = spawnSync(process.execPath, ['--test', probePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    return {
      ...result,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      loaded: existsSync(loadedMarker),
      suite: existsSync(suiteMarker),
      assertion: existsSync(assertionMarker),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('built-output guard contract', () => {
  it('keeps the dashboard build immediately before the marker-enabled data test in CI', () => {
    const workflow = readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
    const expectedSequence = [
      '      - name: Build dashboard artifacts for built-output tests',
      '        run: VITE_VARIANT=full ./node_modules/.bin/vite build',
      '      - run: WM_EXPECT_BUILT_OUTPUT=1 npm run test:data',
    ].join('\n');

    assert.ok(
      workflow.includes(expectedSequence),
      'the unit job must build dashboard artifacts immediately before running test:data with WM_EXPECT_BUILT_OUTPUT=1',
    );
    assert.equal(
      workflow.match(/WM_EXPECT_BUILT_OUTPUT=1 npm run test:data/g)?.length ?? 0,
      1,
      'the CI marker command should remain a single, explicit unit-job contract',
    );
  });

  it('skips the built-output suite when the marker is absent and output is missing', () => {
    const result = runGuardProbe(false);

    assert.equal(result.status, 0, result.output);
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, false, 'node:test should skip the built-output suite');
    assert.equal(result.assertion, false, 'the built-output assertion must not run');
  });

  it('fails the built-output suite when CI expects output but it is missing', () => {
    const result = runGuardProbe(true);

    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, true, 'the suite callback should run when CI expects built output');
    assert.equal(result.assertion, false, 'the assertion must not run after the guard fails');
    assert.match(result.output, /WM_EXPECT_BUILT_OUTPUT=1/);
  });
});
