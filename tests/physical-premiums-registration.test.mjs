import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import { PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS } from '../shared/physical-divergence-staleness.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const PHYSICAL_PREMIUM_KEY = 'market:physical-premium:v1';
const PHYSICAL_PREMIUM_META_KEY = 'seed-meta:market:physical-premium';
const PHYSICAL_DIVERGENCE_KEY = 'market:physical-divergence:v1';
const PHYSICAL_DIVERGENCE_META_KEY = 'seed-meta:market:physical-divergence';

describe('physical premium production registration', () => {
  it('runs in the daily macro bundle without a license env gate', () => {
    const bundle = read('scripts/seed-bundle-macro.mjs');
    assert.match(
      bundle,
      /label: 'Physical-Premiums'.*script: 'seed-physical-premiums\.mjs'.*intervalMs: DAY/s,
    );
    assert.match(
      bundle,
      /label: 'Physical-Premiums'.*timeoutMs: PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS/s,
    );

    const registry = JSON.parse(read('scripts/railway-services.json'));
    const macro = registry.find((entry) => entry.entry === 'scripts/seed-bundle-macro.mjs');
    assert.ok(macro);
    assert.equal(macro.requiredEnv, undefined);
    assert.ok(macro.watchPatterns.includes('scripts/seed-physical-premiums.mjs'));
    assert.ok(macro.watchPatterns.includes('scripts/lib/main-module.mjs'));
    assert.ok(macro.watchPatterns.includes('scripts/lib/physical-divergence.mjs'));
  });

  it('aligns paper freshness with the daily publisher and health alarm', () => {
    const bundle = read('scripts/seed-bundle-macro.mjs');
    const runbook = read('docs/railway-seed-consolidation-runbook.md');
    const healthSrc = read('api/health.js');

    assert.match(
      bundle,
      /label: 'Physical-Premiums'.*intervalMs: DAY/s,
      'the derived snapshot is recomputed at the daily physical-print cadence',
    );
    assert.match(
      runbook,
      /seed-bundle-macro[\s\S]*?`0 8 \* \* \*` \(daily 08:00 UTC\)/,
      'the documented Railway publisher cadence must stay daily',
    );
    assert.equal(PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS, 36 * 60 * 60 * 1000);
    assert.match(
      healthSrc,
      /physicalDivergence:\s+\{[\s\S]*?maxStaleMin: 4320/,
      'the 72-hour operator alarm must remain wider than request freshness',
    );
    assert.ok(PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS >= 24 * 60 * 60 * 1000);
    assert.ok(PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS < 4320 * 60 * 1000);
  });

  it('registers canonical-key, freshness, and two-record health checks', () => {
    const healthSrc = read('api/health.js');
    assert.match(healthSrc, /physicalPremiums:\s+'market:physical-premium:v1'/);
    assert.match(healthSrc, /physicalDivergence:\s+'market:physical-divergence:v1'/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?key: 'seed-meta:market:physical-premium'/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?maxStaleMin: 4320,[\s\S]*?minRecordCount: 2/);
    assert.match(healthSrc, /physicalPremiums:\s+\{[\s\S]*?mode: 'activation-marker',[\s\S]*?issue: 6436/);
    assert.match(healthSrc, /physicalPremiums: SEED_META\.physicalPremiums\.activationKey/);
    assert.match(healthSrc, /'physicalPremiums',/);
    assert.match(healthSrc, /physicalDivergence:\s+\{[\s\S]*?key: 'seed-meta:market:physical-divergence'[\s\S]*?minRecordCount: 2/);
    assert.match(healthSrc, /physicalDivergence:\s+\{[\s\S]*?enforceInputFreshUntil: true/);
    assert.match(read('api/seed-health.js'), /'market:physical-divergence':\s+\{[\s\S]*?enforceInputFreshUntil: true/);
    assert.match(healthSrc, /physicalDivergence: SEED_META\.physicalDivergence\.activationKey/);
    assert.match(healthSrc, /'physicalDivergence',/);

    const seedHealth = read('api/seed-health.js');
    assert.match(
      seedHealth,
      /'market:physical-premium':\s+\{[\s\S]*?key: 'seed-meta:market:physical-premium',[\s\S]*?intervalMin: 2160,[\s\S]*?minRecordCount: 2,[\s\S]*?activationKey: 'seed-activated:market:physical-premium'/,
    );
    assert.match(
      seedHealth,
      /'market:physical-divergence':\s+\{[\s\S]*?key: 'seed-meta:market:physical-divergence',[\s\S]*?intervalMin: 2160,[\s\S]*?minRecordCount: 2,[\s\S]*?activationKey: 'seed-activated:market:physical-divergence'/,
    );

    const seeder = read('scripts/seed-physical-premiums.mjs');
    assert.match(seeder, /PHYSICAL_PREMIUM_ACTIVATION_KEY = 'seed-activated:market:physical-premium'/);
    assert.match(seeder, /PHYSICAL_DIVERGENCE_ACTIVATION_KEY = 'seed-activated:market:physical-divergence'/);

    assert.equal(health.BOOTSTRAP_KEYS.physicalPremiums, undefined);
    assert.equal(health.STANDALONE_KEYS.physicalPremiums, PHYSICAL_PREMIUM_KEY);
    assert.equal(health.STANDALONE_KEYS.physicalDivergence, PHYSICAL_DIVERGENCE_KEY);
    assert.equal(health.ON_DEMAND_KEYS.has('physicalPremiums'), true);
    assert.equal(health.ON_DEMAND_KEYS.has('physicalDivergence'), true);
    assert.equal(
      health.ACTIVATION_MARKERS.physicalPremiums,
      'seed-activated:market:physical-premium',
    );
    assert.equal(
      health.ACTIVATION_MARKERS.physicalDivergence,
      'seed-activated:market:physical-divergence',
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

  it('surfaces stale or missing divergence inputs even when the daily run is fresh', () => {
    const now = 1_800_000_000_000;
    for (const sourceState of ['stale', 'error']) {
      const entry = health.classifyKey(
        'physicalDivergence',
        PHYSICAL_DIVERGENCE_KEY,
        { allowOnDemand: true },
        {
          keyStrens: new Map([[PHYSICAL_DIVERGENCE_KEY, 2048]]),
          keyErrors: new Map(),
          keyMetaValues: new Map([[PHYSICAL_DIVERGENCE_META_KEY, JSON.stringify({
            fetchedAt: now - 60_000,
            recordCount: 2,
            sourceState,
          })]]),
          keyMetaErrors: new Map(),
          activationStates: new Map([['physicalDivergence', true]]),
          now,
        },
      );
      assert.equal(entry.status, 'SEED_ERROR');
      assert.equal(entry.records, 2);
    }

    const expired = health.classifyKey(
      'physicalDivergence',
      PHYSICAL_DIVERGENCE_KEY,
      { allowOnDemand: true },
      {
        keyStrens: new Map([[PHYSICAL_DIVERGENCE_KEY, 2048]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[PHYSICAL_DIVERGENCE_META_KEY, JSON.stringify({
          fetchedAt: now - 60_000,
          recordCount: 2,
          sourceState: 'ok',
          inputFreshUntil: now,
        })]]),
        keyMetaErrors: new Map(),
        activationStates: new Map([['physicalDivergence', true]]),
        now,
      },
    );
    assert.equal(expired.status, 'SEED_ERROR');
  });
});
