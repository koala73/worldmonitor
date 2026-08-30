import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ as healthTesting } from '../api/health.js';

describe('five-factor operational wiring', () => {
  it('registers canonical and seed health with coverage and freshness floors', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.scorecardFiveFactor, 'scorecard:five-factor:v1');
    assert.deepEqual(healthTesting.SEED_META.scorecardFiveFactor, {
      key: 'seed-meta:scorecard:five-factor',
      maxStaleMin: 2160,
      minRecordCount: 180,
      minPoolCounts: { population: 150, food: 80, energy: 120, demographics: 150, technology: 120, defense: 30 },
      cutover: { mode: 'expiring-ack', fromKey: null, issue: 6441, status: 'EMPTY' },
    });
    const base = { status: 'OK', key: 'scorecard:five-factor:v1' };
    assert.deepEqual(healthTesting.composeScorecardReadModelStatus(base, 1), {
      ...base,
      readModelReady: true,
    });
    assert.deepEqual(healthTesting.composeScorecardReadModelStatus(base, 0), {
      ...base,
      status: 'COVERAGE_PARTIAL',
      seedStatus: 'OK',
      readModelReady: false,
    });
    assert.equal(healthTesting.composeScorecardReadModelStatus(base, null, true).status, 'REDIS_PARTIAL');
  });

  it('places the measured cheap section last with safe admission arithmetic', () => {
    const bundle = readFileSync(new URL('../scripts/seed-bundle-resilience.mjs', import.meta.url), 'utf8');
    assert.match(bundle, /label:\s*'Five-Factor-Scorecard'/);
    assert.match(bundle, /timeoutMs:\s*180_000/);
    assert.match(bundle, /196 countries in 1\.82s/);
    assert.match(bundle, /3,716,740-byte snapshot/);
    assert.ok(bundle.indexOf("label: 'Five-Factor-Scorecard'") > bundle.indexOf("label: 'Food-Stocks'"));

    const killGraceMs = 10_000;
    const admissionHeadroomMs = 15_000;
    const scoresReservation = 240_000 + killGraceMs;
    const staticReservation = 280_000 + killGraceMs;
    const scorecardReservation = 180_000 + killGraceMs;
    const maxBundleMs = 570_000;
    assert.ok(scoresReservation + staticReservation + scorecardReservation + admissionHeadroomMs > maxBundleMs,
      'scorecard must defer rather than start after full Scores + Static reservations');
    assert.ok(scoresReservation + scorecardReservation + admissionHeadroomMs < maxBundleMs,
      'scorecard must fit on the next normal tick when long-cadence sections skip');
  });

  it('deploys when the seeder or any of its imported scorecard modules changes', () => {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
    assert.ok(Array.isArray(parsed));
    const service = parsed.find((entry): entry is { service: string; watchPatterns: string[] } =>
      entry != null
      && typeof entry === 'object'
      && 'service' in entry
      && entry.service === 'seed-bundle-resilience'
      && 'watchPatterns' in entry
      && Array.isArray(entry.watchPatterns));
    assert.ok(service);
    assert.ok(service.watchPatterns.includes('scripts/seed-five-factor-scorecard.mjs'));
    for (const file of ['_input-registry.mts', '_methodology.mts', '_score-country.mts', '_snapshot.mts', '_source-adapters.mts', '_source-registry.mts', '_types.mts']) {
      assert.ok(service.watchPatterns.includes(`scripts/scorecard/v1/${file}`), file);
    }
  });
});
