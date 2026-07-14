import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REQUIRED_WATCH_PATTERNS,
  auditRailwayWatchPaths,
  buildRailwayEditArgs,
  buildRailwayWatchPathPatch,
  serializeRailwayWatchPathPatch,
  waitForRailwayWatchPathConvergence,
} from '../scripts/audit-railway-watch-paths.mjs';

function service({
  rootDirectory = 'scripts',
  startCommand = 'node seed-example.mjs',
  watchPatterns = [],
  repo = 'koala73/worldmonitor',
  dockerfilePath,
} = {}) {
  return {
    source: { repo, rootDirectory },
    build: { watchPatterns, dockerfilePath },
    deploy: { startCommand },
  };
}

describe('Railway watch-path audit', () => {
  it('flags WorldMonitor seeders that enumerate files without both broad paths', () => {
    const watchesEverythingByOmission = service();
    delete watchesEverythingByOmission.build.watchPatterns;
    const config = {
      services: {
        narrow: service({
          watchPatterns: [
            'scripts/seed-example.mjs',
            'scripts/_seed-utils.mjs',
            'shared/**',
          ],
        }),
        broad: service({ watchPatterns: ['scripts/**', 'shared/**'] }),
        broadWithEnumeration: service({
          watchPatterns: ['scripts/seed-example.mjs', 'scripts/**', 'shared/**'],
        }),
        watchesEverything: service({ watchPatterns: [] }),
        watchesEverythingByOmission,
        bundleNarrow: service({
          startCommand: 'node seed-bundle-example.mjs',
          watchPatterns: ['scripts/seed-bundle-example.mjs', 'shared/**'],
        }),
        rootRepoNarrow: service({
          rootDirectory: '',
          startCommand: 'node scripts/seed-digest-notifications.mjs',
          watchPatterns: ['Dockerfile.digest-notifications', 'shared/**'],
        }),
        dockerSeederNarrow: service({
          rootDirectory: '',
          startCommand: '',
          dockerfilePath: 'Dockerfile.seed-bundle-portwatch-port-activity',
          watchPatterns: ['Dockerfile.seed-bundle-portwatch-port-activity', 'shared/**'],
        }),
        worker: service({
          startCommand: 'node process-simulation-tasks.mjs --once',
          watchPatterns: ['scripts/process-simulation-tasks.mjs'],
        }),
        otherRepo: service({
          repo: 'example/other',
          watchPatterns: ['scripts/seed-example.mjs'],
        }),
      },
    };

    assert.deepEqual(
      auditRailwayWatchPaths(config).map(({ serviceId, missingPatterns, extraPatterns }) => ({
        serviceId,
        missingPatterns,
        extraPatterns,
      })),
      [
        { serviceId: 'broadWithEnumeration', missingPatterns: [], extraPatterns: ['scripts/seed-example.mjs'] },
        { serviceId: 'bundleNarrow', missingPatterns: ['scripts/**'], extraPatterns: ['scripts/seed-bundle-example.mjs'] },
        { serviceId: 'dockerSeederNarrow', missingPatterns: ['scripts/**'], extraPatterns: [] },
        { serviceId: 'narrow', missingPatterns: ['scripts/**'], extraPatterns: ['scripts/seed-example.mjs', 'scripts/_seed-utils.mjs'] },
        { serviceId: 'rootRepoNarrow', missingPatterns: ['scripts/**'], extraPatterns: [] },
      ],
    );
  });

  it('audits the bootstrap publisher command with or without the scripts prefix', () => {
    const config = {
      services: {
        publisherRootRepoNarrow: service({
          rootDirectory: '',
          startCommand: 'node scripts/publish-bootstrap-tiers.mjs --loop',
          watchPatterns: ['scripts/**'],
        }),
        publisherScriptsRootNarrow: service({
          startCommand: 'node publish-bootstrap-tiers.mjs --loop',
          watchPatterns: ['shared/**'],
        }),
        publisherBroad: service({
          rootDirectory: '',
          startCommand: 'node scripts/publish-bootstrap-tiers.mjs --loop',
          watchPatterns: ['scripts/**', 'shared/**'],
        }),
      },
    };

    assert.deepEqual(
      auditRailwayWatchPaths(config).map(({ serviceId, missingPatterns }) => ({
        serviceId,
        missingPatterns,
      })),
      [
        { serviceId: 'publisherRootRepoNarrow', missingPatterns: ['shared/**'] },
        { serviceId: 'publisherScriptsRootNarrow', missingPatterns: ['scripts/**'] },
      ],
    );
  });

  it('builds a minimal service-config patch for only the drifted services', () => {
    const config = {
      services: {
        narrow: service({ watchPatterns: ['scripts/seed-example.mjs', 'shared/**'] }),
        broad: service({ watchPatterns: ['scripts/**', 'shared/**'] }),
        rootRepo: service({
          rootDirectory: '',
          startCommand: 'node scripts/seed-digest-notifications.mjs',
          watchPatterns: ['Dockerfile.digest-notifications', 'shared/**'],
        }),
      },
    };

    assert.deepEqual(buildRailwayWatchPathPatch(config), {
      services: {
        narrow: {
          build: { watchPatterns: REQUIRED_WATCH_PATTERNS },
        },
        rootRepo: {
          build: {
            watchPatterns: [
              'Dockerfile.digest-notifications',
              'shared/**',
              'scripts/**',
            ],
          },
        },
      },
    });

    assert.deepEqual(buildRailwayEditArgs(config), [
      'environment',
      'edit',
      '--message',
      'ops: enforce broad seeder watch paths (#5288)',
      '--json',
    ]);
    assert.ok(serializeRailwayWatchPathPatch(config).endsWith('\n'));
    assert.deepEqual(
      JSON.parse(serializeRailwayWatchPathPatch(config)),
      buildRailwayWatchPathPatch(config),
    );
  });

  it('allows Railway environment config read-back to converge after a commit', async () => {
    const narrow = {
      services: {
        example: service({ watchPatterns: ['scripts/seed-example.mjs', 'shared/**'] }),
      },
    };
    const broad = {
      services: {
        example: service({ watchPatterns: ['scripts/**', 'shared/**'] }),
      },
    };
    const snapshots = [narrow, narrow, broad];
    let reads = 0;
    let sleeps = 0;

    const remaining = await waitForRailwayWatchPathConvergence(
      () => snapshots[Math.min(reads++, snapshots.length - 1)],
      { attempts: 3, delayMs: 0, sleep: async () => { sleeps += 1; } },
    );

    assert.deepEqual(remaining, []);
    assert.equal(reads, 3);
    assert.equal(sleeps, 2);
  });
});
