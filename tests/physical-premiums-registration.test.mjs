import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const PHYSICAL_PREMIUM_KEY = 'market:physical-premium:v1';
const PHYSICAL_PREMIUM_META_KEY = 'seed-meta:market:physical-premium';

describe('physical premium production registration', () => {
  it('runs in the daily macro bundle without a license env gate', () => {
    const bundle = read('scripts/seed-bundle-macro.mjs');
    assert.match(
      bundle,
      /label: 'Physical-Premiums'.*script: 'seed-physical-premiums\.mjs'.*intervalMs: DAY/s,
    );

    const registry = JSON.parse(read('scripts/railway-services.json'));
    const macro = registry.find((entry) => entry.entry === 'scripts/seed-bundle-macro.mjs');
    assert.ok(macro);
    assert.equal(macro.requiredEnv, undefined);
    assert.ok(macro.watchPatterns.includes('scripts/seed-physical-premiums.mjs'));
    assert.ok(macro.watchPatterns.includes('scripts/lib/main-module.mjs'));
  });

  it('registers canonical-key, freshness, and two-record health checks', () => {
    const healthSrc = read('api/health.js');
    assert.match(healthSrc, /physicalPremiums:\s+'market:physical-premium:v1'/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?key: 'seed-meta:market:physical-premium'/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?maxStaleMin: 4320,[\s\S]*?minRecordCount: 2/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?mode: 'activation-marker',[\s\S]*?issue: 6436/);
    assert.match(healthSrc, /physicalPremiums: SEED_META\.physicalPremiums\.activationKey/);
    assert.match(healthSrc, /'physicalPremiums',/);

    const seedHealth = read('api/seed-health.js');
    assert.match(
      seedHealth,
      /'market:physical-premium':\s+\{[\s\S]*?key: 'seed-meta:market:physical-premium',[\s\S]*?intervalMin: 2160,[\s\S]*?minRecordCount: 2,[\s\S]*?activationKey: 'seed-activated:market:physical-premium'/,
    );

    const seeder = read('scripts/seed-physical-premiums.mjs');
    assert.match(seeder, /PHYSICAL_PREMIUM_ACTIVATION_KEY = 'seed-activated:market:physical-premium'/);
    assert.match(seeder, /afterPublish: \(\) => markPhysicalPremiumActivated\(\{ env \}\)/);

    assert.equal(health.BOOTSTRAP_KEYS.physicalPremiums, undefined);
    assert.equal(health.STANDALONE_KEYS.physicalPremiums, PHYSICAL_PREMIUM_KEY);
    assert.equal(health.ON_DEMAND_KEYS.has('physicalPremiums'), true);
    assert.equal(
      health.ACTIVATION_MARKERS.physicalPremiums,
      'seed-activated:market:physical-premium',
    );
  });

  it('softens absence only before the first successful publish, then is strict', () => {
    const base = {
      keyStrens: new Map([[PHYSICAL_PREMIUM_KEY, 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[PHYSICAL_PREMIUM_META_KEY, null]]),
      keyMetaErrors: new Map(),
      now: 1_800_000_000_000,
    };
    assert.equal(health.classifyKey(
      'physicalPremiums',
      PHYSICAL_PREMIUM_KEY,
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['physicalPremiums', false]]) },
    ).status, 'EMPTY_ON_DEMAND');
    assert.equal(health.classifyKey(
      'physicalPremiums',
      PHYSICAL_PREMIUM_KEY,
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['physicalPremiums', true]]) },
    ).status, 'EMPTY');
    assert.equal(health.classifyKey(
      'physicalPremiums',
      PHYSICAL_PREMIUM_KEY,
      { allowOnDemand: false },
      { ...base, activationStates: new Map([['physicalPremiums', false]]) },
    ).status, 'EMPTY');
  });
});
