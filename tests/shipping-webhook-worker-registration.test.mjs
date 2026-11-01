import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import {
  WORKER_ACTIVATION_KEY,
  WORKER_META_KEY,
  WORKER_STATUS_KEY,
} from '../scripts/shipping-webhook-worker.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'));
const now = 1_800_000_000_000;

function classify({ strlen, meta, activated }) {
  return health.classifyKey(
    'shippingWebhookWorker',
    WORKER_STATUS_KEY,
    { allowOnDemand: true },
    {
      keyStrens: new Map([[WORKER_STATUS_KEY, strlen]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[WORKER_META_KEY, meta == null ? null : JSON.stringify(meta)]]),
      keyMetaErrors: new Map(),
      activationStates: new Map([['shippingWebhookWorker', activated]]),
      now,
    },
  ).status;
}

describe('shipping webhook worker deployment registration', () => {
  it('registers an active always-on scripts-root Railway service with its dependency closure', () => {
    const service = registry.find((entry) => entry.service === 'shipping-webhook-worker');
    assert.ok(service);
    assert.equal(service.entry, 'scripts/shipping-webhook-worker.mjs');
    assert.equal(service.deployMode, 'nixpacks-root-scripts');
    assert.equal(service.lifecycle, undefined, 'provisioned in Railway production 2026-10-17');
    assert.equal(service.startCommand, 'node shipping-webhook-worker.mjs');
    assert.equal(service.cronSchedule, null);
    assert.deepEqual(service.requiredEnv, [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'WORLDMONITOR_RELAY_KEY',
    ]);
    for (const dependency of [
      'scripts/shipping-webhook-worker.mjs',
      'scripts/lib/shipping-webhook-delivery.mjs',
      'scripts/lib/notification-webhook-ssrf.cjs',
      'scripts/lib/occurrence-events.cjs',
      'scripts/lib/point-to-iso2.mjs',
      'scripts/lib/main-module.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/_seed-envelope-source.mjs',
      'scripts/shared/compare-and-delete-script.cjs',
      'scripts/shared/event-triggers.json',
      'scripts/shared/country-bboxes.json',
      'scripts/shared/country-name-to-iso2.cjs',
      'scripts/shared/country-names.json',
      'scripts/nixpacks.toml',
      'scripts/package.json',
      'scripts/package-lock.json',
    ]) {
      assert.ok(service.watchPatterns.includes(dependency), `${dependency} must trigger a deploy`);
    }
  });

  it('registers health keys the worker writes', () => {
    assert.equal(health.STANDALONE_KEYS.shippingWebhookWorker, WORKER_STATUS_KEY);
    assert.deepEqual(health.SEED_META.shippingWebhookWorker, {
      key: WORKER_META_KEY,
      maxStaleMin: 15,
      activationKey: WORKER_ACTIVATION_KEY,
      cutover: { mode: 'activation-marker', fromKey: null, issue: 9217, activationKey: WORKER_ACTIVATION_KEY },
    });
    assert.equal(health.ON_DEMAND_KEYS.has('shippingWebhookWorker'), true);
    assert.equal(health.ACTIVATION_MARKERS.shippingWebhookWorker, WORKER_ACTIVATION_KEY);
  });

  it('softens only the pre-activation window and accepts zero subscribers while fresh', () => {
    assert.equal(classify({ strlen: 0, meta: null, activated: false }), 'EMPTY_ON_DEMAND');
    assert.equal(classify({ strlen: 0, meta: null, activated: true }), 'EMPTY');
    const fresh = { fetchedAt: now - 60_000, recordCount: 0, sourceState: 'ok' };
    assert.equal(classify({ strlen: 80, meta: fresh, activated: true }), 'OK');
    assert.equal(classify({ strlen: 80, meta: { ...fresh, fetchedAt: now - 16 * 60_000 }, activated: true }), 'STALE_SEED');
    assert.equal(classify({ strlen: 80, meta: { ...fresh, recordCount: 3, sourceState: 'error' }, activated: true }), 'SEED_ERROR');
  });
});
