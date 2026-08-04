// #6142 — the one definition of "can this change reach this service", shared by
// the CI deploy trigger and the deploy-drift check.
//
// The replay suite at the bottom is the load-bearing one. Its cases are real
// (service config, commit, Railway verdict) triples taken from production on
// 2026-08-04, because the whole point of moving this matching into the
// repository is that it must agree with what Railway actually does — a matcher
// that is merely self-consistent would re-report the 57 false rejections that
// motivated the build-context rule.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { ROOT_DIRECTORY_BY_DEPLOY_MODE as AUDIT_ROOT_DIRECTORY_BY_DEPLOY_MODE } from '../scripts/audit-railway-watch-paths.mjs';
import {
  CHECK_SUITE_FAILED_REASON,
  NO_MATCHING_PATHS_REASON,
  ROOT_DIRECTORY_BY_DEPLOY_MODE,
  buildContextPrefix,
  changeReachesService,
  createChangedPathsReader,
  isLegitimatePathSkip,
  pathsReachingService,
  resolveServiceClosure,
  watchPatternToRegExp,
} from '../scripts/railway-deploy-closure.mjs';

describe('watch pattern compilation', () => {
  it('lets ** span path separators and keeps * within one segment', () => {
    assert.ok(watchPatternToRegExp('scripts/**').test('scripts/seed-aviation.mjs'));
    assert.ok(watchPatternToRegExp('scripts/**').test('scripts/lib/llm-telemetry.cjs'));
    assert.ok(!watchPatternToRegExp('scripts/*.mjs').test('scripts/lib/deep.mjs'));
    assert.ok(watchPatternToRegExp('scripts/*.mjs').test('scripts/seed-aviation.mjs'));
  });

  it('matches an exact path as itself and nothing near it', () => {
    const expression = watchPatternToRegExp('scripts/_seed-utils.mjs');
    assert.ok(expression.test('scripts/_seed-utils.mjs'));
    assert.ok(!expression.test('scripts/_seed-utils.mjs.bak'));
    assert.ok(!expression.test('other/scripts/_seed-utils.mjs'));
  });

  it('does not let a dot in a pattern become a wildcard', () => {
    // Dockerfile.relay must not match Dockerfile-relay or DockerfileXrelay:
    // the escape is what keeps an exact closure exact.
    const expression = watchPatternToRegExp('Dockerfile.relay');
    assert.ok(expression.test('Dockerfile.relay'));
    assert.ok(!expression.test('DockerfileXrelay'));
  });

  it('returns null for shapes it does not implement', () => {
    // Callers must read null as "assume it matches". Compiling a negation as if
    // it were a literal would silently invert a service's closure.
    assert.equal(watchPatternToRegExp('!scripts/ignored.mjs'), null);
    assert.equal(watchPatternToRegExp('scripts/{a,b}.mjs'), null);
    assert.equal(watchPatternToRegExp('scripts/[ab].mjs'), null);
    assert.equal(watchPatternToRegExp(''), null);
    assert.equal(watchPatternToRegExp(undefined), null);
  });

  it('treats an unsupported pattern as reaching everything in the context', () => {
    const closure = { patterns: ['!scripts/ignored.mjs'], rootDirectory: '' };
    assert.ok(changeReachesService(closure, ['docs/unrelated.md']));
  });

  it('lets ** match zero path segments, not just one or more', () => {
    // A character-wise compiler turns `scripts/**/*.mjs` into
    // `scripts/.*/[^/]*\.mjs`, whose literal slashes demand an intervening
    // directory — so the pattern silently stops matching top-level files. The
    // closure is then narrowed by the compiler rather than by anything the
    // service declared, which strands it on stale code.
    const nested = watchPatternToRegExp('scripts/**/*.mjs');
    assert.ok(nested.test('scripts/seed-foo.mjs'), 'zero intervening segments');
    assert.ok(nested.test('scripts/lib/seed-foo.mjs'), 'one intervening segment');
    assert.ok(nested.test('scripts/lib/a/b.mjs'), 'several intervening segments');
    assert.ok(!nested.test('scripts/seed-foo.cjs'), 'extension still binds');

    const anyDepth = watchPatternToRegExp('**/foo.mjs');
    assert.ok(anyDepth.test('foo.mjs'), 'at the repository root');
    assert.ok(anyDepth.test('a/b/foo.mjs'), 'nested');
  });

  it('keeps a trailing ** meaning everything below', () => {
    // The fleet's most common pattern by far — 46 services carry
    // `scripts/**` + `shared/**`.
    const under = watchPatternToRegExp('scripts/**');
    assert.ok(under.test('scripts/seed-aviation.mjs'));
    assert.ok(under.test('scripts/lib/llm-telemetry.cjs'));
    assert.ok(!under.test('shared/country-names.json'));
    assert.ok(watchPatternToRegExp('**').test('anything/at/all'));
  });

  it('accepts the repository-rooted form Railway documents', () => {
    // Railway's docs write watch paths as `/src/**` and `/*.go`. Compiled
    // literally that anchors on a leading slash no repository-relative path
    // has, producing a regex that can never match — a closure silently narrowed
    // to nothing, which is the one direction this module must never fail in.
    assert.ok(watchPatternToRegExp('/scripts/**').test('scripts/seed-aviation.mjs'));
    assert.ok(watchPatternToRegExp('/*.go').test('main.go'));
    assert.ok(watchPatternToRegExp('./scripts/**').test('scripts/seed-aviation.mjs'));
    assert.ok(watchPatternToRegExp('/scripts/_seed-utils.mjs').test('scripts/_seed-utils.mjs'));
  });
});

describe('build context from the registry alone', () => {
  it('derives the root directory from deployMode, the field the registry has', () => {
    // Registry entries carry deployMode, never a rootDirectory key. Reading one
    // is a branch that can never fire, which leaves a registry-only service
    // rooted at the repository — containment silently switched off.
    const scriptsRooted = resolveServiceClosure({
      registryEntry: { deployMode: 'nixpacks-root-scripts', watchPatterns: ['scripts/**', 'shared/**'] },
    });
    assert.equal(scriptsRooted.rootDirectory, 'scripts');
    assert.ok(!changeReachesService(scriptsRooted, ['shared/china-decision-signals.ts']));
    assert.ok(changeReachesService(scriptsRooted, ['scripts/seed-aviation.mjs']));

    for (const deployMode of ['nixpacks-root-repo', 'dockerfile']) {
      const repoRooted = resolveServiceClosure({
        registryEntry: { deployMode, watchPatterns: ['shared/**'] },
      });
      assert.equal(repoRooted.rootDirectory, '', deployMode);
      assert.ok(changeReachesService(repoRooted, ['shared/china-decision-signals.ts']), deployMode);
    }
  });

  it('agrees with the map the live audit enforces', () => {
    // Two copies of "where does this deployMode root its build" is how the
    // trigger and the audit come to disagree about one service's containment.
    assert.deepEqual(
      { ...ROOT_DIRECTORY_BY_DEPLOY_MODE },
      { ...AUDIT_ROOT_DIRECTORY_BY_DEPLOY_MODE },
    );
  });

  it('lets the live root directory win over the registry\'s claim', () => {
    // Railway builds from what Railway is configured with; the registry's
    // deployMode is the repository's claim about it, which the audit reconciles.
    const closure = resolveServiceClosure({
      registryEntry: { deployMode: 'nixpacks-root-scripts', watchPatterns: ['shared/**'] },
      liveService: { source: { rootDirectory: '' }, build: { watchPatterns: ['shared/**'] } },
    });
    assert.equal(closure.rootDirectory, '');
  });
});

describe('build context containment', () => {
  it('derives the prefix from the root directory, tolerating stray slashes', () => {
    assert.equal(buildContextPrefix('scripts'), 'scripts/');
    assert.equal(buildContextPrefix('/scripts/'), 'scripts/');
    assert.equal(buildContextPrefix(''), '');
    assert.equal(buildContextPrefix(null), '');
  });

  it('keeps a repository-root shared/ change away from a scripts-rooted service', () => {
    // The rule the 57 apparent refusals turned out to be: a nixpacks
    // rootDirectory: scripts build cannot see repository-root shared/, so the
    // shared/** pattern several such services carry is unreachable by
    // construction. Without containment this asserts the opposite and the
    // drift check invents a rejection.
    const closure = resolveServiceClosure({
      liveService: {
        source: { rootDirectory: 'scripts' },
        build: { watchPatterns: ['scripts/**', 'shared/**'] },
      },
    });
    assert.ok(!changeReachesService(closure, ['shared/china-decision-signals.ts']));
    assert.ok(changeReachesService(closure, ['scripts/seed-aviation.mjs']));
  });

  it('keeps that same change relevant to a repository-rooted service', () => {
    const closure = resolveServiceClosure({
      liveService: {
        source: { rootDirectory: '' },
        build: { watchPatterns: ['scripts/**', 'shared/**'] },
      },
    });
    assert.ok(changeReachesService(closure, ['shared/china-decision-signals.ts']));
  });
});

describe('closure resolution', () => {
  it('unions the registry closure with the live filter', () => {
    // Between a merged registry edit and the audit's --apply, each side knows a
    // path the other does not; three of the fleet's apparent refusals sat in
    // exactly that window. Building too much is the only safe direction.
    const closure = resolveServiceClosure({
      registryEntry: { watchPatterns: ['scripts/_seed-history.mjs'] },
      liveService: {
        source: { rootDirectory: 'scripts' },
        build: { watchPatterns: ['scripts/_seed-utils.mjs'] },
      },
    });
    assert.deepEqual(closure.patterns, ['scripts/_seed-history.mjs', 'scripts/_seed-utils.mjs']);
    assert.ok(changeReachesService(closure, ['scripts/_seed-history.mjs']));
    assert.ok(changeReachesService(closure, ['scripts/_seed-utils.mjs']));
  });

  it('reads an explicitly empty registry array as watching everything', () => {
    // umami and publish-bootstrap-tiers use [] deliberately.
    const closure = resolveServiceClosure({ registryEntry: { watchPatterns: [] } });
    assert.equal(closure.patterns, null);
    assert.ok(changeReachesService(closure, ['src/App.ts']));
  });

  it('reads a missing registry key as no opinion rather than as watching everything', () => {
    // 30 of the registry's 41 entries omit watchPatterns entirely. Treating
    // that as [] would widen every one of them to the whole repository.
    const closure = resolveServiceClosure({
      registryEntry: { service: 'seed-forecasts' },
      liveService: {
        source: { rootDirectory: 'scripts' },
        build: { watchPatterns: ['scripts/seed-forecasts.mjs'] },
      },
    });
    assert.deepEqual(closure.patterns, ['scripts/seed-forecasts.mjs']);
    assert.ok(!changeReachesService(closure, ['scripts/seed-aviation.mjs']));
  });

  it('reads an absent live filter as watching everything', () => {
    for (const build of [{ watchPatterns: null }, { watchPatterns: [] }, {}]) {
      const closure = resolveServiceClosure({ liveService: { source: {}, build } });
      assert.equal(closure.patterns, null, `build=${JSON.stringify(build)}`);
    }
  });

  it('falls back to watching everything when neither source describes the service', () => {
    assert.equal(resolveServiceClosure({}).patterns, null);
    assert.equal(resolveServiceClosure().patterns, null);
    assert.equal(resolveServiceClosure({ registryEntry: { service: 'x' } }).patterns, null);
  });

  it('reports which paths reached the service, not just that some did', () => {
    const closure = resolveServiceClosure({
      liveService: { source: { rootDirectory: '' }, build: { watchPatterns: ['scripts/**'] } },
    });
    assert.deepEqual(
      pathsReachingService(closure, ['docs/a.md', 'scripts/b.mjs', 'scripts/lib/c.cjs']),
      ['scripts/b.mjs', 'scripts/lib/c.cjs'],
    );
  });
});

describe('skip classification', () => {
  const closure = resolveServiceClosure({
    liveService: {
      source: { rootDirectory: 'scripts' },
      build: { watchPatterns: ['scripts/**'] },
    },
  });

  it('accepts a path skip our own matcher agrees with', () => {
    const deployment = { status: 'SKIPPED', meta: { skippedReason: NO_MATCHING_PATHS_REASON } };
    assert.ok(isLegitimatePathSkip(deployment, closure, ['src/App.ts']));
  });

  it('rejects a path skip our own matcher disputes', () => {
    const deployment = { status: 'SKIPPED', meta: { skippedReason: NO_MATCHING_PATHS_REASON } };
    assert.ok(!isLegitimatePathSkip(deployment, closure, ['scripts/seed-aviation.mjs']));
  });

  it('never excuses a skip that is not about paths', () => {
    // The dominant lag source: Railway reads the commit's whole check suite, so
    // a scheduled monitor that re-reports a failure onto main's head SHA after
    // the merge defers every service's deploy. Excusing it here would make the
    // drift check green while the fleet sits on old code.
    const deployment = { status: 'SKIPPED', meta: { skippedReason: CHECK_SUITE_FAILED_REASON } };
    assert.ok(!isLegitimatePathSkip(deployment, closure, ['src/App.ts']));
  });

  it('never excuses a reason Railway adds later', () => {
    const deployment = { status: 'SKIPPED', meta: { skippedReason: 'Some reason from 2027' } };
    assert.ok(!isLegitimatePathSkip(deployment, closure, ['src/App.ts']));
  });

  it('withholds the excuse when the commit\'s file list is unavailable', () => {
    // A shallow checkout that cannot reach the commit must leave the service
    // reported, not excused: "we could not check" is not "it was fine".
    const deployment = { status: 'SKIPPED', meta: { skippedReason: NO_MATCHING_PATHS_REASON } };
    assert.ok(!isLegitimatePathSkip(deployment, closure, null));
  });

  it('ignores deployments that are not skips', () => {
    for (const status of ['SUCCESS', 'FAILED', 'BUILDING', 'REMOVED']) {
      assert.ok(!isLegitimatePathSkip({ status, meta: {} }, closure, ['src/App.ts']));
    }
  });
});

describe('changed-path reader', () => {
  const HEAD = 'cf3ac8777fdd2de42b3740a4b9a18c7159ad5b4e';
  const RUNNING = 'f1a85003e99cd762e67ad561f5155b53a359e4e6';

  it('returns the diff between the running commit and head', () => {
    const read = createChangedPathsReader(HEAD, { git: () => 'scripts/a.mjs\nshared/b.ts\n' });
    assert.deepEqual(read(RUNNING), ['scripts/a.mjs', 'shared/b.ts']);
  });

  it('asks git for the range between the two commits, with renames off', () => {
    // --no-renames is load-bearing: with detection on (git's default),
    // --name-only prints only a renamed file's DESTINATION path, so a closure
    // naming the old path stops matching and the service is silently stranded.
    // Verified against 3abc27af9, where the old path drops out entirely.
    let seen = null;
    createChangedPathsReader(HEAD, { git: (args) => { seen = args; return ''; } })(RUNNING);
    assert.deepEqual(seen, ['diff', '--name-only', '--no-renames', `${RUNNING}..${HEAD}`]);
  });

  it('returns null rather than an empty list when git cannot answer', () => {
    // Empty would mean "nothing changed", which silently excuses the service.
    const read = createChangedPathsReader(HEAD, { git: () => { throw new Error('bad object'); } });
    assert.equal(read(RUNNING), null);
  });

  it('distinguishes "nothing changed" from "could not tell"', () => {
    assert.deepEqual(createChangedPathsReader(HEAD, { git: () => '' })(RUNNING), []);
  });

  it('asks git once per running commit', () => {
    let calls = 0;
    const read = createChangedPathsReader(HEAD, { git: () => { calls += 1; return 'scripts/a.mjs\n'; } });
    read(RUNNING);
    read(RUNNING);
    assert.equal(calls, 1);
  });

  it('refuses to be built without a git runner rather than defaulting to null', () => {
    // A silent default would make every service read CLOSURE_UNKNOWN, which is
    // noisy but survivable — and would make every deploy plan fire, which is
    // not. Fail at construction instead.
    assert.throws(() => createChangedPathsReader(HEAD), TypeError);
    assert.throws(() => createChangedPathsReader(HEAD, {}), TypeError);
  });
});

// --- Replay against production -------------------------------------------
//
// Real service configuration, real commits, and the verdict Railway itself
// recorded on 2026-08-04. Each case is one of the shapes the fleet-wide
// re-measurement turned up; together they pin the three rules that make our
// matcher agree with Railway's (containment, exact-path matching, no filter =
// everything).
//
// `changedPaths` is TRIMMED to the files that decide the case, which is what
// makes the fixture readable and also what makes it silently corruptible: a
// path that the commit never touched still produces a plausible-looking row,
// and then the suite is testing an invented commit rather than the one Railway
// judged. That already happened once. So each case also pins the commit's FULL
// file list, `changedPaths` is asserted to be a subset of it, and the full list
// itself is checked against git whenever the commit is reachable — which it is
// locally and in the deep-history workflows, but not in CI's shallow unit job.

const REPLAY = [
  {
    name: 'a desktop-only merge does not reach a broad-filter seeder',
    service: { source: { rootDirectory: 'scripts' }, build: { watchPatterns: ['scripts/**', 'shared/**'] } },
    commit: '045094590',
    commitFiles: [
      'AGENTS.md',
      'docs/desktop-parity-matrix.md',
      'docs/generated/stats.json',
      'src-tauri/open-url-safety.test.mjs',
      'src/App.ts',
      'src/app/desktop-updater.ts',
      'src/app/event-handlers.ts',
      'src/components/Panel.ts',
      'src/components/ResilienceWidget.ts',
      'src/components/RouteExplorer/RouteExplorer.ts',
      'src/components/RuntimeConfigPanel.ts',
      'src/components/UnifiedSettings.ts',
      'src/config/web-origin.ts',
      'src/services/billing.ts',
      'src/services/checkout-no-user-policy.ts',
      'src/services/checkout-return-url.ts',
      'src/services/checkout.ts',
      'src/services/desktop-runtime.ts',
      'src/services/external-navigation.ts',
      'src/services/notifications-settings.ts',
      'src/services/panel-gating.ts',
      'src/services/runtime.ts',
      'src/settings-main.ts',
      'src/utils/follow-button.ts',
      'tests/checkout-overlay-lifecycle.test.mts',
      'tests/checkout-pending-dialog.test.mts',
      'tests/checkout-report-error.test.mts',
      'tests/checkout-return-url.test.mts',
      'tests/checkout-unparsable-success-body.test.mts',
      'tests/desktop-checkout-handoff.test.mts',
      'tests/desktop-external-handoff.test.mts',
      'tests/dom/export-gate-wiring.test.mts',
      'tests/dom/gate-action.test.mts',
      'tests/dom/unified-settings-upgrade-click-runtime.test.mts',
      'tests/external-navigation-call-sites.test.mjs',
      'tests/followed-countries-cap-drop-toast.test.mjs',
      'tests/runtime-env-guards.test.mjs',
      'tests/window-open-noopener.test.mjs',
    ],
    changedPaths: ['AGENTS.md', 'docs/desktop-parity-matrix.md', 'src/App.ts', 'src/app/desktop-updater.ts'],
    railwayBuilt: false,
  },
  {
    name: 'a seeder-entry-point merge does reach a broad-filter seeder',
    service: { source: { rootDirectory: 'scripts' }, build: { watchPatterns: ['scripts/**', 'shared/**'] } },
    commit: '7bf19630e',
    commitFiles: [
      'consumer-prices-core/src/jobs/aggregate.ts',
      'consumer-prices-core/src/jobs/publish.ts',
      'consumer-prices-core/src/jobs/scrape.ts',
      'scripts/fetch-gpsjam.mjs',
      'scripts/process-deep-forecast-tasks.mjs',
      'scripts/process-simulation-tasks.mjs',
      'scripts/publish-bootstrap-tiers.mjs',
      'scripts/seed-bundle-regional.mjs',
      'scripts/seed-comtrade-bilateral-hs4.mjs',
      'scripts/seed-electricity-prices.mjs',
      'scripts/seed-ember-electricity.mjs',
      'scripts/seed-energy-spine.mjs',
      'scripts/seed-forecast-bets.mjs',
      'scripts/seed-hs2-chokepoint-exposure.mjs',
      'scripts/seed-regulatory-actions.mjs',
      'tests/railway-entrypoint-terminal-marker.test.mts',
    ],
    changedPaths: ['consumer-prices-core/src/jobs/aggregate.ts', 'scripts/fetch-gpsjam.mjs', 'scripts/process-simulation-tasks.mjs'],
    railwayBuilt: true,
  },
  {
    name: 'a repository-root shared/ change does not reach a scripts-rooted worker that lists shared/**',
    service: {
      source: { rootDirectory: 'scripts' },
      build: { watchPatterns: ['scripts/process-deep-forecast-tasks.mjs', 'scripts/_seed-utils.mjs', 'shared/**'] },
    },
    commit: '89de2e6b0',
    commitFiles: [
      'docs/china-logistics-corridors.mdx',
      'docs/methodology/china-activity-nowcast.mdx',
      'docs/zh/china-logistics-corridors.mdx',
      'docs/zh/methodology/china-activity-nowcast.mdx',
      'scripts/seed-supply-chain-trade.mjs',
      'server/worldmonitor/economic/v1/get-china-activity-nowcast.ts',
      'server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts',
      'shared/china-activity-nowcast-registry.ts',
      'tests/china-activity-nowcast-handler.test.mts',
      'tests/china-ccfi-period-change-seam.test.mts',
      'tests/china-corridor-source-adapters.test.mts',
      'tests/freight-indices.test.mjs',
    ],
    changedPaths: ['docs/china-logistics-corridors.mdx', 'scripts/seed-supply-chain-trade.mjs', 'shared/china-activity-nowcast-registry.ts'],
    railwayBuilt: false,
  },
  {
    name: 'a repository-root package.json change does not reach a scripts-rooted worker that lists package.json',
    service: {
      source: { rootDirectory: 'scripts' },
      build: { watchPatterns: ['scripts/scenario-worker.mjs', 'scripts/_seed-utils.mjs', 'package.json', 'package-lock.json', 'shared/**'] },
    },
    commit: '1f113208c',
    commitFiles: [
      'CONCEPTS.md',
      'docs/health-endpoints.mdx',
      'docs/solutions/runtime-errors/ais-relay-self-request-configured-vs-bound-port.md',
      'package.json',
      'scripts/ais-relay-ingestion.test.cjs',
      'scripts/ais-relay-test-preload.cjs',
      'scripts/ais-relay.cjs',
      'scripts/seed-military-flights.mjs',
    ],
    changedPaths: ['CONCEPTS.md', 'package.json', 'scripts/ais-relay-ingestion.test.cjs'],
    railwayBuilt: false,
  },
  {
    name: 'an unfiltered service is reached by any merge at all',
    service: { source: { rootDirectory: '' }, build: { watchPatterns: [] } },
    commit: 'cf3ac8777',
    commitFiles: [
      'src/app/panel-layout.ts',
      'src/services/checkout-return-url.ts',
      'src/services/checkout-return.ts',
      'src/services/checkout.ts',
      'tests/checkout-return-discriminant.test.mts',
      'tests/checkout-return-url.test.mts',
      'tests/desktop-checkout-handoff.test.mts',
      'tests/entitlement-reload-controller.test.mts',
    ],
    changedPaths: ['src/services/checkout-return.ts', 'src/services/checkout.ts'],
    railwayBuilt: true,
  },
];

describe('replay against recorded production verdicts (#6142)', () => {
  for (const testCase of REPLAY) {
    it(testCase.name, () => {
      const closure = resolveServiceClosure({ liveService: testCase.service });
      assert.equal(
        changeReachesService(closure, testCase.changedPaths),
        testCase.railwayBuilt,
        `disagrees with Railway on ${testCase.commit}: it ${testCase.railwayBuilt ? 'built' : 'skipped'} this commit`,
      );
    });
  }

  it('covers both verdicts, so a matcher stuck on one answer cannot pass', () => {
    assert.ok(REPLAY.some((testCase) => testCase.railwayBuilt), 'no build case');
    assert.ok(REPLAY.some((testCase) => !testCase.railwayBuilt), 'no skip case');
  });

  it('trims each case to real files, never invented ones', () => {
    // Runs everywhere, including CI's shallow checkout. Catches the drift that
    // already happened once: a decisive path that the commit never touched.
    for (const testCase of REPLAY) {
      assert.ok(Array.isArray(testCase.commitFiles) && testCase.commitFiles.length > 0,
        `${testCase.commit} must pin the commit's full file list`);
      const invented = testCase.changedPaths.filter((path) => !testCase.commitFiles.includes(path));
      assert.deepEqual(invented, [],
        `${testCase.commit} (${testCase.name}) cites path(s) the commit never changed — the case is judging an invented commit`);
    }
  });

  it('pins file lists that match the commits themselves', (t) => {
    // The subset check above is only as good as the pinned list, so verify the
    // list against git wherever the commit is reachable. CI's unit job checks
    // out depth 1, so this skips there — visibly, rather than passing quietly.
    const reachable = REPLAY.filter((testCase) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${testCase.commit}^{commit}`], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });
    if (reachable.length === 0) {
      t.skip('no replay commit is reachable in this checkout (shallow clone) — pinned lists unverified here');
      return;
    }
    for (const testCase of reachable) {
      const actual = execFileSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', testCase.commit],
        { encoding: 'utf8' },
      ).split('\n').filter(Boolean).sort();
      assert.deepEqual(
        [...testCase.commitFiles].sort(),
        actual,
        `${testCase.commit} pinned file list no longer matches the commit`,
      );
    }
  });
});
