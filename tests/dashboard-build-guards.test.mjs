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
  it('builds /pro before full and focused prehydration browser checks', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const fullE2eScript = packageJson.scripts?.['test:e2e:full'] ?? '';
    const prehydrationScript = packageJson.scripts?.['test:e2e:prehydration'] ?? '';
    const prehydrationSource = readFileSync(
      resolve(repoRoot, 'e2e/prehydration-shell.spec.ts'),
      'utf8',
    );
    const workflow = readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
    const expectedCiSequence = [
      '      - name: Build /pro artifacts for prehydration browser checks',
      '        # public/pro/ is built output since #6898. Keep this explicit and',
      '        # immediately before the focused spec so the browser checks cannot run',
      '        # against missing or stale bytes from another build.',
      '        run: npm run build:pro',
      '      - name: Run fail-closed prehydration browser checks',
      '        id: prehydration',
      '        run: npm run test:e2e:prehydration',
    ].join('\n');

    assert.match(
      fullE2eScript,
      /^npm run build:pro && /,
      'test:e2e:full must build ignored /pro output before Playwright starts',
    );
    assert.match(
      prehydrationScript,
      /playwright test e2e\/prehydration-shell\.spec\.ts --project=chromium --grep [^&]*server-rendered welcome page\|dashboard shell without JavaScript/,
      'the focused CI script must execute all formerly guarded prehydration checks in Chromium',
    );
    assert.doesNotMatch(
      prehydrationSource,
      /test\.skip\(!proWelcomeBuilt/,
      'the prehydration spec must fail when /pro output is absent, not silently skip',
    );
    assert.ok(
      workflow.includes(expectedCiSequence),
      'PR CI must build /pro immediately before the focused prehydration browser checks',
    );
  });

  it('keeps the dashboard build immediately before the marker-enabled data test in CI', () => {
    const workflow = readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
    // The bundle-size gate (#7111) sits between the build and test:data on
    // purpose: it reads the freshly built dist/ without mutating it, and a
    // budget breach should cost seconds, not the full test:data run. Pinning
    // it in this sequence keeps both contracts — the data test still runs
    // against the dist the step above just built, and the gate cannot drift
    // to a position where dist/ might be stale or absent.
    const expectedSequence = [
      '        run: npm run build:pro',
      '      - name: Build dashboard artifacts for built-output tests',
      '        run: VITE_VARIANT=full ./node_modules/.bin/vite build',
      '      - name: Client bundle size budget (#7111)',
    ].join('\n');
    const expectedTailSequence = [
      '        run: npm run bundle:check',
      '      - run: WM_EXPECT_BUILT_OUTPUT=1 npm run test:data',
    ].join('\n');

    assert.ok(
      workflow.includes(expectedSequence),
      'the unit job must build /pro then dashboard artifacts, then run the bundle-size gate against that fresh dist',
    );
    assert.ok(
      workflow.includes(expectedTailSequence),
      'the bundle-size gate must run immediately before test:data with WM_EXPECT_BUILT_OUTPUT=1, with nothing between it and the build except the gate itself',
    );
    assert.equal(
      workflow.match(/WM_EXPECT_BUILT_OUTPUT=1 npm run test:data/g)?.length ?? 0,
      1,
      'the CI marker command should remain a single, explicit unit-job contract',
    );
  });

  it('wires the /pro guard to the shared primitive and the prerendered page', async () => {
    // The skip/fail behaviour itself is proven with teeth by the probe cases
    // below, which exercise the shared primitive. What that probe cannot reach
    // is the /pro wrapper, because it resolves its own path -- so pin the two
    // things the wrapper contributes: which file it watches, and that it
    // delegates rather than reimplementing the skip/fail decision.
    const proGuard = await import('./_lib/pro-built-output.mjs');
    assert.match(
      proGuard.PRO_BUILT_MARKER,
      /public\/pro\/welcome\.html$/,
      'the /pro marker must be the prerendered welcome page',
    );

    const source = readFileSync(resolve(repoRoot, 'tests/_lib/pro-built-output.mjs'), 'utf8');
    assert.match(
      source,
      /from '\.\/built-output-guard\.mjs'/,
      'the /pro helper must delegate to the shared built-output primitive, not fork it',
    );
    assert.match(
      source,
      /shouldSkipBuiltOutput\(PRO_BUILT_MARKER\)/,
      'shouldSkipProBuiltOutput must ask the shared primitive about the /pro marker',
    );
    assert.match(
      source,
      /guardBuiltOutput\(PRO_BUILT_MARKER/,
      'guardProBuiltOutput must ask the shared primitive about the /pro marker',
    );
  });

  it('keeps the /pro build-output existence check in the freshness workflow', () => {
    // The only thing standing between a broken pro build and a 404 at /pro is
    // this check: #6898 stopped committing public/pro/, so no byte in git covers
    // for a build that emitted nothing. `vite build` succeeding is not the same
    // as the two entry pages existing -- a rollupOptions.input rename would ship
    // a green build and an empty route.
    const freshness = readFileSync(
      resolve(repoRoot, '.github/workflows/pro-bundle-freshness.yml'),
      'utf8',
    ).replaceAll('\r\n', '\n');

    for (const page of ['public/pro/index.html', 'public/pro/welcome.html']) {
      assert.ok(
        freshness.includes(page),
        `pro-bundle-freshness.yml must assert ${page} exists after the build`,
      );
    }
    assert.match(
      freshness,
      /if \[ ! -s "\$page" \]; then/,
      'the existence check must test for a NON-EMPTY file (-s), not merely a present one',
    );
    assert.match(
      freshness,
      /run: cd pro-test && npm run build/,
      'the existence check is only meaningful if the workflow actually builds pro-test',
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
