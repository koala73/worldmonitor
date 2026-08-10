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
    ]);
    for (const dependency of [
      'scripts/company-monitoring-worker.mjs',
      'scripts/_proxy-utils.cjs',
      'scripts/_seed-utils.mjs',
      'scripts/_seed-contract.mjs',
      'scripts/_seed-envelope-source.mjs',
      'scripts/lib/llm-telemetry.cjs',
      'scripts/lib/main-module.mjs',
      'scripts/nixpacks.toml',
      'scripts/package.json',
      'scripts/package-lock.json',
    ]) {
      assert.ok(service.watchPatterns.includes(dependency), `${dependency} must trigger a deploy`);
    }
  });

  it('softens only the pre-activation window and registers strict worker freshness', () => {
    assert.equal(health.STANDALONE_KEYS.companyMonitoringWorker, 'company-monitoring:worker-health:v1');
    assert.deepEqual(health.SEED_META.companyMonitoringWorker, {
      key: 'seed-meta:company-monitoring:worker',
      maxStaleMin: 5,
      workerControl: true,
    });
    assert.equal(health.ON_DEMAND_KEYS.has('companyMonitoringWorker'), true);
    assert.equal(
      health.ACTIVATION_MARKERS.companyMonitoringWorker,
      'seed-activated:company-monitoring:worker',
    );

    const base = {
      keyStrens: new Map([['company-monitoring:worker-health:v1', 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([['seed-meta:company-monitoring:worker', null]]),
      keyMetaErrors: new Map(),
      now: 1_800_000_000_000,
    };
    assert.equal(health.classifyKey(
      'companyMonitoringWorker',
      'company-monitoring:worker-health:v1',
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['companyMonitoringWorker', false]]) },
    ).status, 'EMPTY_ON_DEMAND');
    assert.equal(health.classifyKey(
      'companyMonitoringWorker',
      'company-monitoring:worker-health:v1',
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['companyMonitoringWorker', true]]) },
    ).status, 'EMPTY');
  });

  it('projects only the closed worker control-plane status, outcome, and counters', () => {
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

    assert.equal(entry.status, 'OK');
    assert.deepEqual(entry.workerControl, {
      status: 'ok',
      outcome: 'disabled',
      counters: {
        loops: 2,
        claims: 0,
        completed: 0,
        nonReassuring: 0,
        fenced: 0,
        replayed: 0,
        executorErrors: 0,
        claimErrors: 0,
        finalizeErrors: 0,
      },
    });
    assert.equal(JSON.stringify(entry).includes('must-not-project'), false);
  });
});
