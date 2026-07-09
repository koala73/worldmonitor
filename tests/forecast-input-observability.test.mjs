import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildForecastInputFetchKeys,
  buildForecastInputPresenceRows,
  warnOnMissingForecastInputs,
} from '../scripts/seed-forecasts.mjs';

describe('forecast input observability', () => {
  it('reports zero records for missing or empty forecast input feeds by Redis key', () => {
    const rows = buildForecastInputPresenceRows({
      'temporal:anomalies:v1': null,
      'conflict:acled:v1:all:0:0': { events: [] },
      'economic:fred:v1:FEDFUNDS:0': {
        series: { observations: [{ date: '2026-07-01', value: 4.25 }] },
      },
      'market:stocks-bootstrap:v1': { quotes: [{ symbol: 'SPY', price: 600 }] },
      'theater_posture:sebuf:stale:v1': 'valid-json-but-wrong-shape',
    });

    assert.equal(rows.find((row) => row.key === 'temporal:anomalies:v1')?.records, 0);
    assert.equal(rows.find((row) => row.key === 'conflict:acled:v1:all:0:0')?.records, 0);
    assert.equal(rows.find((row) => row.key === 'economic:fred:v1:FEDFUNDS:0')?.records, 1);
    assert.equal(rows.find((row) => row.key === 'market:stocks-bootstrap:v1')?.records, 1);
    assert.equal(rows.find((row) => row.key === 'theater_posture:sebuf:stale:v1')?.records, 0);
  });

  it('reports zero records for enabled feed definitions missing from parsed inputs', () => {
    const rows = buildForecastInputPresenceRows({
      'temporal:anomalies:v1': { anomalies: [{ id: 'a1' }] },
    });

    assert.equal(rows.find((row) => row.key === 'temporal:anomalies:v1')?.records, 1);
    assert.equal(rows.find((row) => row.key === 'conflict:acled:v1:all:0:0')?.records, 0);
  });

  it('does not warn for intentionally disabled forecast input definitions', () => {
    const previousIranEventsEnabled = process.env.IRAN_EVENTS_ENABLED;
    delete process.env.IRAN_EVENTS_ENABLED;
    try {
      const rows = buildForecastInputPresenceRows({});

      assert.equal(rows.some((row) => row.key === 'conflict:iran-events:v1'), false);
    } finally {
      if (previousIranEventsEnabled === undefined) delete process.env.IRAN_EVENTS_ENABLED;
      else process.env.IRAN_EVENTS_ENABLED = previousIranEventsEnabled;
    }
  });

  it('counts event feeds by their semantic events array', () => {
    const rows = buildForecastInputPresenceRows({
      'conflict:ucdp-events:v1': { meta: ['cached'], events: [] },
      'unrest:events:v1': { meta: ['cached'], events: [{ id: 'u1' }] },
    });

    assert.equal(rows.find((row) => row.key === 'conflict:ucdp-events:v1')?.records, 0);
    assert.equal(rows.find((row) => row.key === 'unrest:events:v1')?.records, 1);
  });

  it('counts temporal anomaly snapshots by tracked coverage, not rare anomalies', () => {
    const rows = buildForecastInputPresenceRows({
      'temporal:anomalies:v1': {
        anomalies: [],
        trackedTypes: ['news', 'satellite_fires'],
        computedAt: '2026-07-09T00:00:00.000Z',
      },
    });

    assert.equal(rows.find((row) => row.key === 'temporal:anomalies:v1')?.records, 2);
  });

  it('requires prediction-market bootstrap coverage to include finance markets', () => {
    const rows = buildForecastInputPresenceRows({
      'prediction:markets-bootstrap:v1': {
        geopolitical: [{ id: 'geo-1' }],
        tech: [],
        finance: [],
      },
    });

    assert.equal(rows.find((row) => row.key === 'prediction:markets-bootstrap:v1')?.records, 0);

    const coveredRows = buildForecastInputPresenceRows({
      'prediction:markets-bootstrap:v1': {
        geopolitical: [{ id: 'geo-1' }],
        tech: [],
        finance: [{ id: 'fin-1' }],
      },
    });

    assert.equal(coveredRows.find((row) => row.key === 'prediction:markets-bootstrap:v1')?.records, 2);
  });

  it('sums generic top-level array collections instead of taking the largest sibling', () => {
    const rows = buildForecastInputPresenceRows({
      'conflict:ema-windows:v1': {
        shortWindows: [{ id: 's1' }, { id: 's2' }],
        longWindows: [{ id: 'l1' }],
        computedAt: '2026-07-09T00:00:00.000Z',
      },
    });

    assert.equal(rows.find((row) => row.key === 'conflict:ema-windows:v1')?.records, 3);

    const emptyRows = buildForecastInputPresenceRows({
      'conflict:ema-windows:v1': {
        shortWindows: [],
        longWindows: [],
        computedAt: '2026-07-09T00:00:00.000Z',
      },
    });

    assert.equal(emptyRows.find((row) => row.key === 'conflict:ema-windows:v1')?.records, 0);
  });

  it('counts only usable FRED observations, not metadata-only payloads', () => {
    const rows = buildForecastInputPresenceRows({
      'economic:fred:v1:FEDFUNDS:0': {
        series: { seriesId: 'FEDFUNDS', title: 'Federal Funds Effective Rate' },
      },
      'economic:fred:v1:VIXCLS:0': {
        observations: [{ date: '2026-07-01', value: 18.2 }],
      },
    });

    assert.equal(rows.find((row) => row.key === 'economic:fred:v1:FEDFUNDS:0')?.records, 0);
    assert.equal(rows.find((row) => row.key === 'economic:fred:v1:VIXCLS:0')?.records, 1);
  });

  it('derives Redis fetch keys from the forecast input feed definitions', () => {
    const fetchKeys = buildForecastInputFetchKeys();
    const presenceKeys = buildForecastInputPresenceRows({}).map((row) => row.key);

    assert.deepEqual(fetchKeys, presenceKeys);
    assert.equal(new Set(fetchKeys).size, fetchKeys.length);
  });

  it('warns once per zero-record forecast input with feed key and count', () => {
    const warnings = [];
    const logger = { warn: (line) => warnings.push(String(line)) };

    warnOnMissingForecastInputs([
      { key: 'temporal:anomalies:v1', label: 'temporalAnomalies', records: 0 },
      { key: 'conflict:acled:v1:all:0:0', label: 'acledEvents', records: 0 },
      { key: 'economic:fred:v1:FEDFUNDS:0', label: 'fred:FEDFUNDS', records: 3 },
    ], logger);

    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /\[ForecastInputs\]/);
    assert.match(warnings[0], /temporal:anomalies:v1/);
    assert.match(warnings[0], /records=0/);
    assert.match(warnings[1], /conflict:acled:v1:all:0:0/);
  });
});
