import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'));

describe('company monitoring worker deployment registration', () => {
  it('registers an always-on scripts-root Railway service with its full dependency closure', () => {
    const service = registry.find((entry) => entry.service === 'company-monitoring-worker');
    assert.ok(service);
    assert.equal(service.entry, 'scripts/company-monitoring-worker.mjs');
    assert.equal(service.deployMode, 'nixpacks-root-scripts');
    assert.equal(service.startCommand, 'node company-monitoring-worker.mjs');
    assert.equal(service.cronSchedule, null);
    assert.deepEqual(service.requiredEnv, [
      'CONVEX_URL',
      'COMPANY_MONITORING_WORKER_SECRET',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'X_BEARER_TOKEN',
    ]);
    for (const dependency of [
      'scripts/company-monitoring-worker.mjs',
      'scripts/lib/company-monitoring-exa.mjs',
      'scripts/lib/company-monitoring-x-provider.mjs',
      'scripts/_proxy-utils.cjs',
      'scripts/_seed-utils.mjs',
      'scripts/_seed-contract.mjs',
      'scripts/_seed-envelope-source.mjs',
      'scripts/lib/llm-telemetry.cjs',
      'scripts/lib/main-module.mjs',
      'scripts/lib/notification-webhook-ssrf.cjs',
      'scripts/nixpacks.toml',
      'scripts/package.json',
      'scripts/package-lock.json',
    ]) {
      assert.ok(service.watchPatterns.includes(dependency), `${dependency} must trigger a deploy`);
    }
  });

  it('keeps the health reader dark until Railway pre-seed evidence exists', () => {
    const service = registry.find((entry) => entry.service === 'company-monitoring-worker');
    assert.match(service.documentedAt, /pending provisioning.*#6402/i);
    assert.equal(health.STANDALONE_KEYS.companyMonitoringWorker, undefined);
    assert.equal(health.SEED_META.companyMonitoringWorker, undefined);
    assert.equal(health.ON_DEMAND_KEYS.has('companyMonitoringWorker'), false);
    assert.equal(health.ACTIVATION_MARKERS.companyMonitoringWorker, undefined);
  });

  it('does not project unpublished worker metadata before health registration', () => {
    const redisKey = 'company-monitoring:worker-health:v1';
    const metaKey = 'seed-meta:company-monitoring:worker';
    const entry = health.classifyKey(
      'companyMonitoringWorker',
      redisKey,
      { allowOnDemand: true },
      {
        keyStrens: new Map([[redisKey, 120]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[metaKey, JSON.stringify({
          fetchedAt: 1_800_000_000_000,
          recordCount: 1,
          sourceState: 'ok',
          status: 'ok',
          outcome: 'disabled',
          counters: { loops: 2, claims: 0, unexpected: 99 },
          secret: 'must-not-project',
        })]]),
        keyMetaErrors: new Map(),
        activationStates: new Map([['companyMonitoringWorker', true]]),
        now: 1_800_000_000_000,
      },
    );

    assert.equal(entry.workerControl, undefined);
    assert.equal(JSON.stringify(entry).includes('must-not-project'), false);
  });
});
