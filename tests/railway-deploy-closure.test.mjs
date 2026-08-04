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
import { describe, it } from 'node:test';

import {
  CHECK_SUITE_FAILED_REASON,
  NO_MATCHING_PATHS_REASON,
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

  it('asks git for the range between the two commits', () => {
    let seen = null;
    createChangedPathsReader(HEAD, { git: (args) => { seen = args; return ''; } })(RUNNING);
    assert.deepEqual(seen, ['diff', '--name-only', `${RUNNING}..${HEAD}`]);
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
// everything). Trimmed to the files that decide each case.

const REPLAY = [
  {
    name: 'a desktop-only merge does not reach a broad-filter seeder',
    service: { source: { rootDirectory: 'scripts' }, build: { watchPatterns: ['scripts/**', 'shared/**'] } },
    commit: '045094590',
    changedPaths: ['AGENTS.md', 'docs/desktop-parity-matrix.md', 'src/App.ts', 'src/app/desktop-updater.ts'],
    railwayBuilt: false,
  },
  {
    name: 'a seeder-entry-point merge does reach a broad-filter seeder',
    service: { source: { rootDirectory: 'scripts' }, build: { watchPatterns: ['scripts/**', 'shared/**'] } },
    commit: '7bf19630e',
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
    changedPaths: ['CONCEPTS.md', 'package.json', 'scripts/ais-relay-ingestion.test.cjs'],
    railwayBuilt: false,
  },
  {
    name: 'an unfiltered service is reached by any merge at all',
    service: { source: { rootDirectory: '' }, build: { watchPatterns: [] } },
    commit: 'cf3ac8777',
    changedPaths: ['src/App.ts', 'src/services/checkout.ts'],
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
});
