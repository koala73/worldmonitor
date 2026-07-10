import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';

describe('forecast resolution health registration', () => {
  it('classifies the resolution ledger and scorecard as standalone health checks', () => {
    assert.equal(__testing__.STANDALONE_KEYS.forecastResolutions, 'forecast:resolutions:v1');
    assert.equal(__testing__.STANDALONE_KEYS.forecastScorecard, 'forecast:scorecard:v1');
    assert.equal(__testing__.SEED_META.forecastResolutions.key, 'seed-meta:forecast:resolutions');
    assert.equal(__testing__.SEED_META.forecastScorecard.key, 'seed-meta:forecast:scorecard');
  });

  it('keeps forecast input feeds visible in strict health monitoring', () => {
    assert.equal(__testing__.STANDALONE_KEYS.temporalAnomalies, 'temporal:anomalies:v1');
    assert.equal(__testing__.SEED_META.temporalAnomalies.key, 'seed-meta:temporal:anomalies');
    assert.equal(__testing__.SEED_META.temporalAnomalies.maxStaleMin, 45);
    assert.equal(__testing__.STANDALONE_KEYS.acledIntel, 'conflict:acled:v1:all:0:0');
    assert.equal(__testing__.SEED_META.acledIntel.key, 'seed-meta:conflict:acled-intel');
    assert.equal(__testing__.SEED_META.acledIntel.maxStaleMin, 38);
    assert.equal(__testing__.BOOTSTRAP_KEYS.fredBatch, 'economic:fred:v1:FEDFUNDS:0');

    const forecastFredInputs = {
      forecastFredWalcl: 'economic:fred:v1:WALCL:0',
      forecastFredT10y2y: 'economic:fred:v1:T10Y2Y:0',
      forecastFredUnrate: 'economic:fred:v1:UNRATE:0',
      forecastFredCpiaucsl: 'economic:fred:v1:CPIAUCSL:0',
      forecastFredDgs10: 'economic:fred:v1:DGS10:0',
      forecastFredVixcls: 'economic:fred:v1:VIXCLS:0',
      forecastFredGdp: 'economic:fred:v1:GDP:0',
      forecastFredM2sl: 'economic:fred:v1:M2SL:0',
      forecastFredDcoilwtico: 'economic:fred:v1:DCOILWTICO:0',
    };

    for (const [name, dataKey] of Object.entries(forecastFredInputs)) {
      assert.equal(__testing__.STANDALONE_KEYS[name], dataKey, `${name} data key`);
      assert.equal(__testing__.SEED_META[name]?.key, `seed-meta:${dataKey}`, `${name} seed-meta key`);
      assert.equal(__testing__.SEED_META[name]?.maxStaleMin, 1500, `${name} maxStaleMin`);
    }
  });

  it('treats a missing ACLED/GDELT conflict feed as a strict health problem', () => {
    const entry = __testing__.classifyKey(
      'acledIntel',
      __testing__.STANDALONE_KEYS.acledIntel,
      { allowOnDemand: true },
      {
        keyStrens: new Map(),
        keyErrors: new Map(),
        keyMetaValues: new Map(),
        keyMetaErrors: new Map(),
        now: 1_700_000_000_000,
      },
    );

    assert.equal(entry.status, 'EMPTY');
  });

  it('treats a missing temporal-anomalies forecast feed as a strict health problem', () => {
    const entry = __testing__.classifyKey(
      'temporalAnomalies',
      __testing__.STANDALONE_KEYS.temporalAnomalies,
      { allowOnDemand: true },
      {
        keyStrens: new Map(),
        keyErrors: new Map(),
        keyMetaValues: new Map(),
        keyMetaErrors: new Map(),
        now: 1_700_000_000_000,
      },
    );

    assert.equal(entry.status, 'EMPTY');
  });

  it('treats a freshly computed zero-anomaly snapshot as healthy coverage', () => {
    const now = 1_700_000_000_000;
    const entry = __testing__.classifyKey(
      'temporalAnomalies',
      __testing__.STANDALONE_KEYS.temporalAnomalies,
      { allowOnDemand: true },
      {
        keyStrens: new Map([[__testing__.STANDALONE_KEYS.temporalAnomalies, 96]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[
          'seed-meta:temporal:anomalies',
          JSON.stringify({ fetchedAt: now - 60_000, recordCount: 2 }),
        ]]),
        keyMetaErrors: new Map(),
        now,
      },
    );

    assert.equal(entry.status, 'OK');
  });
});
