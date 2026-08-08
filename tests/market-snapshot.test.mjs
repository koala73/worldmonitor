import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DATASETS, buildMarketSnapshot, marketSnapshotToMarkdown, normalizeDataset } from '../api/_market-snapshot.js';

describe('market snapshot export', () => {
  const def = { id: 'x', key: 'x', domain: 'gold', source: 'test', cadenceMin: 5, staleAfterMin: 30 };
  it('never invents a value for missing/error inputs', () => {
    assert.deepEqual(normalizeDataset(def, { result: null }, 1), {
      ...def,
      status: 'missing',
      data: null,
      fetchedAt: null,
      observedAt: null,
      fetchAgeMin: null,
      observationAgeMin: null,
      ageMin: null,
      maxContentAgeMin: null,
      staleMemberCount: 0,
      quality: ['missing'],
    });
    assert.equal(normalizeDataset(def, { error: 'down' }, 1).data, null);
  });
  it('uses envelope metadata for freshness and marks stale data', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const entry = { result: JSON.stringify({ _seed: { fetchedAt: now - 31 * 60000 }, data: { value: 7 } }) };
    const out = normalizeDataset(def, entry, now);
    assert.equal(out.status, 'stale');
    assert.equal(out.ageMin, 31);
    assert.equal(out.fetchAgeMin, 31);
    assert.equal(out.observationAgeMin, 31);
    assert.deepEqual(out.data, { value: 7 });
  });
  it('keeps fetch and content clocks separate and honors the seed content-age budget', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const observedAt = now - 40 * 60000;
    const entry = {
      result: JSON.stringify({
        _seed: { fetchedAt: now, newestItemAt: observedAt, maxContentAgeMin: 30 },
        data: { updatedAt: new Date(now).toISOString(), value: 7 },
      }),
    };

    const out = normalizeDataset(def, entry, now);

    assert.equal(out.status, 'stale');
    assert.equal(out.fetchedAt, '2026-08-08T12:00:00.000Z');
    assert.equal(out.observedAt, '2026-08-08T11:20:00.000Z');
    assert.equal(out.fetchAgeMin, 0);
    assert.equal(out.observationAgeMin, 40);
    assert.equal(out.ageMin, 0);
    assert.equal(out.maxContentAgeMin, 30);
    assert.ok(out.quality.includes('content_stale'));
  });
  it('preserves an explicit missing envelope observation clock instead of relabeling it', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const entry = {
      result: JSON.stringify({
        _seed: { fetchedAt: now, newestItemAt: null, maxContentAgeMin: 30 },
        data: { updatedAt: new Date(now).toISOString(), value: 7 },
      }),
    };

    const out = normalizeDataset(def, entry, now);

    assert.equal(out.status, 'unknown');
    assert.equal(out.observedAt, null);
    assert.equal(out.fetchAgeMin, 0);
    assert.equal(out.observationAgeMin, null);
    assert.equal(out.ageMin, 0);
    assert.ok(out.quality.includes('observation_timestamp_missing'));
    assert.ok(out.quality.includes('timestamp_missing'));
  });
  it('classifies future fetch and observation clocks as stale without hiding their negative ages', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const future = now + 10 * 60000;
    const cases = [
      {
        label: 'fetch',
        seed: { fetchedAt: future },
        expectedFetchAge: -10,
        expectedObservationAge: -10,
        expectedQuality: ['fetch_timestamp_future', 'observation_timestamp_future'],
      },
      {
        label: 'observation',
        seed: { fetchedAt: now, newestItemAt: future, maxContentAgeMin: 30 },
        expectedFetchAge: 0,
        expectedObservationAge: -10,
        expectedQuality: ['observation_timestamp_future'],
      },
    ];

    for (const item of cases) {
      const entry = {
        result: JSON.stringify({
          _seed: item.seed,
          data: { value: 7 },
        }),
      };
      const out = normalizeDataset(def, entry, now);
      assert.equal(out.status, 'stale', item.label);
      assert.equal(out.fetchAgeMin, item.expectedFetchAge, item.label);
      assert.equal(out.observationAgeMin, item.expectedObservationAge, item.label);
      assert.equal(out.ageMin, 0, item.label);
      assert.ok(out.quality.includes('future_timestamp'), item.label);
      for (const reason of item.expectedQuality) {
        assert.ok(out.quality.includes(reason), `${item.label}: ${reason}`);
      }
    }
  });
  it('uses real periodic observation fields before seed-time updatedAt', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const updatedAt = new Date(now).toISOString();
    const cases = [
      { id: 'cotPositioning', data: { reportDate: '2026-08-01', updatedAt }, observedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'goldEtfFlows', data: { asOfDate: '2026-08-02', updatedAt }, observedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'goldCentralBankReserves', data: { asOfMonth: '2026-07', updatedAt }, observedAt: '2026-07-01T00:00:00.000Z' },
      { id: 'euYieldCurve', data: { date: '2026-08-05', updatedAt }, observedAt: '2026-08-05T00:00:00.000Z' },
      {
        id: 'fedFunds',
        data: { seriesId: 'FEDFUNDS', observations: [{ date: '2026-08-04', value: 4.25 }], updatedAt },
        observedAt: '2026-08-04T00:00:00.000Z',
      },
    ];

    for (const item of cases) {
      const definition = { ...def, id: item.id, staleAfterMin: 100_000 };
      const entry = { result: JSON.stringify({ _seed: { fetchedAt: now }, data: item.data }) };
      const out = normalizeDataset(definition, entry, now);
      assert.equal(out.observedAt, item.observedAt, item.id);
      assert.equal(out.fetchAgeMin, 0, item.id);
      assert.ok(out.observationAgeMin > 0, item.id);
    }
  });
  it('fails closed when a fresh Hyperliquid envelope carries stale assets', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');
    const definition = { ...def, id: 'positioning247' };
    const entry = {
      result: JSON.stringify({
        _seed: { fetchedAt: now },
        data: {
          fetchedAt: new Date(now).toISOString(),
          assets: [{ symbol: 'BTC', stale: true }, { symbol: 'ETH', stale: false }],
        },
      }),
    };

    const out = normalizeDataset(definition, entry, now);

    assert.equal(out.status, 'stale');
    assert.equal(out.staleMemberCount, 1);
    assert.ok(out.quality.includes('stale_members'));
  });
  it('builds JSON and Markdown from the same snapshot object', () => {
    const entries = DATASETS.map(() => ({ result: null }));
    const snapshot = buildMarketSnapshot(entries, Date.parse('2026-08-08T00:00:00Z'));
    assert.equal(snapshot.summary.missing, DATASETS.length);
    const markdown = marketSnapshotToMarkdown(snapshot);
    assert.match(markdown, /Not a prediction, predictive score/);
    assert.match(markdown, /Status: missing/);
    assert.match(markdown, /- Age: unknown/);
    assert.match(markdown, /- Fetch age: unknown/);
    assert.match(markdown, /- Observation age: unknown/);
    assert.doesNotMatch(markdown, /undefined/);
  });
});
