import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
  buildRailwayServiceConfigPatch,
} from '../scripts/audit-railway-watch-paths.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
);

function service({
  cronSchedule = '0 * * * *',
  dockerfilePath,
  variables = {},
  watchPatterns = [],
} = {}) {
  return {
    source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
    build: {
      watchPatterns,
      ...(dockerfilePath === undefined ? {} : { dockerfilePath }),
    },
    deploy: { cronSchedule, startCommand: 'node seed-example.mjs' },
    variables,
  };
}

describe('critical ingestion Railway registry drift regressions', () => {
  it('fails closed for missing and empty production drift settings', () => {
    const derivedSignals = registry.find(
      (entry) => entry.service === 'seed-bundle-derived-signals',
    );
    const umami = registry.find((entry) => entry.service === 'umami');
    assert.ok(derivedSignals, 'derived-signals bundle must be registered');
    assert.ok(umami, 'umami must be registered');
    assert.deepEqual(
      derivedSignals.watchPatterns,
      [],
      'derived-signals must build on every push, not on an enumerated closure',
    );
    assert.equal(umami.dockerfile, 'Dockerfile.umami');

    const derivedServiceId = 'svc-derived-signals';
    const umamiServiceId = 'svc-umami';
    const serviceIds = new Map([
      [derivedSignals.service, derivedServiceId],
      [umami.service, umamiServiceId],
    ]);
    const liveDerivedSignals = service({
      cronSchedule: derivedSignals.cronSchedule,
      watchPatterns: [],
      variables: { JAPAN_MOD_PROXY_URL: 'https://proxy.example' },
    });
    const liveUmami = service({
      cronSchedule: null,
      dockerfilePath: umami.dockerfile,
      watchPatterns: [],
      variables: {
        APP_SECRET: 'configured',
        DATABASE_URL: 'postgres://configured',
      },
    });
    liveUmami.source.rootDirectory = '';

    const canonicalConfig = {
      services: {
        [derivedServiceId]: liveDerivedSignals,
        [umamiServiceId]: liveUmami,
      },
    };
    const managedRegistry = [derivedSignals, umami];
    assert.deepEqual(
      auditRailwayServiceConfig(canonicalConfig, serviceIds, managedRegistry),
      [],
      'the paired production contract should audit clean before either setting drifts',
    );

    const umamiExpectedDrift = {
      service: umami.service,
      serviceId: umamiServiceId,
      missingService: false,
      watchPatterns: null,
      cronSchedule: null,
      dockerfilePath: { actual: '', expected: umami.dockerfile },
    };
    const umamiExpectedPatch = {
      build: { dockerfilePath: umami.dockerfile },
    };
    const cases = [
      {
        // The regression this file now guards: someone re-enters a filter in
        // the Railway dashboard to save build minutes on a */5 bundle, and the
        // service quietly stops receiving merges. The exact closure below is
        // the one this service shipped until #6141 — narrowness is not what
        // makes a filter safe, because nothing about it is.
        name: 'derived-signals watch-path filter restored in the dashboard',
        serviceId: derivedServiceId,
        mutate(config) {
          config.services[derivedServiceId].build.watchPatterns = [
            'scripts/seed-bundle-derived-signals.mjs',
            'scripts/_bundle-runner.mjs',
          ];
        },
        expectedDrift: {
          service: derivedSignals.service,
          serviceId: derivedServiceId,
          missingService: false,
          watchPatterns: {
            actual: [
              'scripts/seed-bundle-derived-signals.mjs',
              'scripts/_bundle-runner.mjs',
            ],
            expected: [],
          },
          cronSchedule: null,
        },
        expectedPatch: {
          build: { watchPatterns: [] },
        },
      },
      {
        name: 'Umami Dockerfile path omitted',
        serviceId: umamiServiceId,
        mutate(config) {
          delete config.services[umamiServiceId].build.dockerfilePath;
        },
        expectedDrift: umamiExpectedDrift,
        expectedPatch: umamiExpectedPatch,
      },
      {
        name: 'Umami Dockerfile path empty',
        serviceId: umamiServiceId,
        mutate(config) {
          config.services[umamiServiceId].build.dockerfilePath = '';
        },
        expectedDrift: umamiExpectedDrift,
        expectedPatch: umamiExpectedPatch,
      },
    ];

    for (const testCase of cases) {
      const driftedConfig = structuredClone(canonicalConfig);
      testCase.mutate(driftedConfig);
      const drift = auditRailwayServiceConfig(
        driftedConfig,
        serviceIds,
        managedRegistry,
      );
      assert.deepEqual(drift, [testCase.expectedDrift], testCase.name);
      assert.deepEqual(
        buildRailwayServiceConfigPatch(drift),
        { services: { [testCase.serviceId]: testCase.expectedPatch } },
        `${testCase.name} patch`,
      );
    }
    assert.deepEqual(
      derivedSignals.watchPatterns,
      [],
      'audit and patch construction must not mutate the registry watch-path contract',
    );
  });
});
