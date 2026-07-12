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

  it('registers the funnel-diversity guardrail (#5233) as a standalone health check', () => {
    // data key + companion seed-meta must stay paired so a collapsed funnel
    // (seed-meta status:'error') surfaces via classifyKey's seedError path.
    assert.equal(__testing__.STANDALONE_KEYS.forecastFunnel, 'forecast:funnel:health:v1');
    assert.equal(__testing__.SEED_META.forecastFunnel.key, 'seed-meta:forecast:funnel:health:v1');
    // absent-key window (before the first generator run ships it) must be
    // tolerated as warn, never a hard EMPTY crit.
    assert.ok(__testing__.EMPTY_DATA_OK_KEYS.has('forecastFunnel'));
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

// The load-bearing claims of the funnel guardrail (#5233) driven through
// classifyKey — not just constant presence — so a future refactor of the
// EMPTY_DATA_OK_KEYS / seedError paths can't silently regress them.
describe('funnel-diversity guardrail health classification', () => {
  const NOW = 1_700_000_000_000;
  const DATA_KEY = 'forecast:funnel:health:v1';
  const META_KEY = 'seed-meta:forecast:funnel:health:v1';

  function classify(ctxOverrides) {
    return __testing__.classifyKey('forecastFunnel', DATA_KEY, { allowOnDemand: true }, {
      keyStrens: new Map(),
      keyErrors: new Map(),
      keyMetaValues: new Map(),
      keyMetaErrors: new Map(),
      now: NOW,
      ...ctxOverrides,
    });
  }

  it('surfaces a collapsed funnel (seed-meta status:error) as SEED_ERROR → warn', () => {
    const entry = classify({
      keyStrens: new Map([[DATA_KEY, 120]]),
      keyMetaValues: new Map([[META_KEY, JSON.stringify({
        fetchedAt: NOW - 60_000, recordCount: 2, status: 'error', reasons: ['only 2 distinct domain(s) (min 4)'],
      })]]),
    });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(__testing__.STATUS_COUNTS[entry.status], 'warn');
  });

  it('tolerates the absent-key window (before the cron ships it) as warn, never a crit EMPTY', () => {
    const entry = classify({}); // no data, no meta
    assert.notEqual(__testing__.STATUS_COUNTS[entry.status], 'crit');
    assert.equal(entry.status, 'STALE_SEED');
  });

  it('reports a fresh, diverse funnel as OK', () => {
    const entry = classify({
      keyStrens: new Map([[DATA_KEY, 120]]),
      keyMetaValues: new Map([[META_KEY, JSON.stringify({
        fetchedAt: NOW - 60_000, recordCount: 6, status: 'ok',
      })]]),
    });
    assert.equal(entry.status, 'OK');
  });

  it('does not false-crit an empty (recordCount 0) run while the seed is fresh', () => {
    const entry = classify({
      keyStrens: new Map([[DATA_KEY, 40]]),
      keyMetaValues: new Map([[META_KEY, JSON.stringify({
        fetchedAt: NOW - 60_000, recordCount: 0, status: 'ok',
      })]]),
    });
    assert.notEqual(__testing__.STATUS_COUNTS[entry.status], 'crit');
  });
});
