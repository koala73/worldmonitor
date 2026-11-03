import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  WILDFIRE_FIRES_SUMMARY_KEY,
  WILDFIRE_FIRES_SUMMARY_META_KEY,
  WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY,
  WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION,
  parseWildfireFiresSummary,
  summarizeWildfireDetections,
} from '../scripts/shared/wildfire-fires-summary.mjs';

const NOW = 1_792_500_000_000;
const HOUR_MS = 60 * 60 * 1000;

const firms = (lat: number, lon: number, over: Record<string, unknown> = {}) => ({
  id: `${lat}-${lon}`,
  location: { latitude: lat, longitude: lon },
  brightness: 340,
  frp: 12,
  detectedAt: NOW - 30 * 60_000,
  source: 'firms',
  ...over,
});

describe('summarizeWildfireDetections', () => {
  it('attributes detections to Tier-1 countries with the CII border file and keeps only the scored fields', () => {
    const summary = summarizeWildfireDetections({
      fireDetections: [
        firms(39, -98, { brightness: 400, frp: 60 }),
        firms(48.5, 37.9, { brightness: 'hot', frp: -4 }),
        firms(49, -120),
        firms(0, -160),
      ],
    }, { nowMs: NOW });
    assert.ok(summary);
    assert.deepEqual(summary.byCountry, {
      UA: [{ brightness: 0, frp: 0 }],
      US: [{ brightness: 400, frp: 60 }],
    });
    assert.equal(summary.totalCount, 4);
    assert.equal(summary.schemaVersion, WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION);
  });

  it('accepts the flat lat/lon and latitude/longitude spellings the scorer accepted', () => {
    const summary = summarizeWildfireDetections({
      fireDetections: [
        { lat: 39, lon: -98, brightness: 1, frp: 1 },
        { latitude: 39.5, longitude: -98.5, brightness: 2, frp: 2 },
      ],
    }, { nowMs: NOW });
    assert.deepEqual(summary?.byCountry, { US: [{ brightness: 1, frp: 1 }, { brightness: 2, frp: 2 }] });
  });

  it('reports the pre-cap total from pagination when it exceeds the rows published', () => {
    const summary = summarizeWildfireDetections({
      fireDetections: [firms(39, -98)],
      pagination: { nextCursor: '', totalCount: 17_000 },
    }, { nowMs: NOW });
    assert.equal(summary?.totalCount, 17_000);
    const smaller = summarizeWildfireDetections({
      fireDetections: [firms(39, -98), firms(39, -98)],
      pagination: { nextCursor: '', totalCount: 1 },
    }, { nowMs: NOW });
    assert.equal(smaller?.totalCount, 2);
  });

  it('clocks FIRMS rows only, skips undatable and far-future rows, and mirrors the FIRMS coverage flags', () => {
    const summary = summarizeWildfireDetections({
      fireDetections: [
        firms(39, -98, { detectedAt: NOW - 2 * HOUR_MS }),
        firms(39, -98, { detectedAt: new Date(NOW - 10 * 60_000).toISOString(), source: '' }),
        firms(39, -98, { detectedAt: NOW + 2 * HOUR_MS }),
        firms(39, -98, { detectedAt: 'not a date' }),
        firms(49, -120, { source: 'cwfis', detectedAt: NOW - 5 * 24 * HOUR_MS }),
        firms(49, -120, { source: 'bc-wildfire', detectedAt: NOW - 1 * 60_000 }),
      ],
      _firmsState: 'ok',
      _firmsPartial: false,
      _firmsCount: 4,
    }, { nowMs: NOW });
    assert.deepEqual(summary?.firms, {
      state: 'ok',
      partial: false,
      count: 4,
      rows: 4,
      newestDetectedAt: NOW - 10 * 60_000,
      oldestDetectedAt: NOW - 2 * HOUR_MS,
    });
  });

  it('leaves the clock null when no FIRMS row can be dated', () => {
    const summary = summarizeWildfireDetections({
      fireDetections: [firms(39, -98, { detectedAt: undefined })],
      _firmsState: 'failed',
      _firmsPartial: true,
    }, { nowMs: NOW });
    assert.deepEqual(summary?.firms, {
      state: 'failed',
      partial: true,
      count: null,
      rows: 1,
      newestDetectedAt: null,
      oldestDetectedAt: null,
    });
  });

  it('summarizes an empty window as zero rows, not as missing data', () => {
    const summary = summarizeWildfireDetections({ fireDetections: [], _firmsState: 'ok', _firmsCount: 0 }, { nowMs: NOW });
    assert.deepEqual(summary, {
      schemaVersion: WILDFIRE_FIRES_SUMMARY_SCHEMA_VERSION,
      totalCount: 0,
      firms: { state: 'ok', partial: false, count: 0, rows: 0, newestDetectedAt: null, oldestDetectedAt: null },
      byCountry: {},
    });
  });

  it('returns null for a payload without a detections array', () => {
    assert.equal(summarizeWildfireDetections(null), null);
    assert.equal(summarizeWildfireDetections({ fires: [] }), null);
    assert.equal(summarizeWildfireDetections([]), null);
  });

  it('serializes byCountry in code order so equal inputs produce equal bytes', () => {
    const a = summarizeWildfireDetections({ fireDetections: [firms(39, -98), firms(48.5, 37.9)] }, { nowMs: NOW });
    const b = summarizeWildfireDetections({ fireDetections: [firms(48.5, 37.9), firms(39, -98)] }, { nowMs: NOW });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(Object.keys(a!.byCountry), ['UA', 'US']);
  });
});

describe('parseWildfireFiresSummary', () => {
  it('round-trips a serialized summary and rejects the shapes a reader must not score', () => {
    const summary = summarizeWildfireDetections({ fireDetections: [firms(39, -98, { brightness: 400, frp: 60 })] }, { nowMs: NOW });
    assert.deepEqual(parseWildfireFiresSummary(JSON.parse(JSON.stringify(summary))), summary);
    assert.equal(parseWildfireFiresSummary(null), null);
    assert.equal(parseWildfireFiresSummary({ fireDetections: [] }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, byCountry: [] }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, totalCount: 'many' }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: null }), null);
  });

  it('rejects a firms block without the fields the content clock branches on', () => {
    // `rows: 0` means "agency-only, skip the clock" and `partial: false` means
    // "complete coverage", so a missing field must not default into either.
    const summary = summarizeWildfireDetections({ fireDetections: [firms(39, -98)], _firmsState: 'ok', _firmsCount: 1 }, { nowMs: NOW })!;
    const { rows: _rows, ...withoutRows } = summary.firms;
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: withoutRows }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: { ...summary.firms, rows: 'one' } }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: { ...summary.firms, rows: -1 } }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: { ...summary.firms, rows: 0.5 } }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, totalCount: 0.5 }), null);
    const { partial: _partial, ...withoutPartial } = summary.firms;
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: withoutPartial }), null);
    assert.equal(parseWildfireFiresSummary({ ...summary, firms: { ...summary.firms, partial: 'no' } }), null);
    assert.deepEqual(parseWildfireFiresSummary({ ...summary, firms: { ...summary.firms, count: undefined, state: undefined } })?.firms, {
      ...summary.firms, count: null, state: null,
    });
  });

  it('drops malformed intensity rows instead of rejecting the whole summary', () => {
    const parsed = parseWildfireFiresSummary({
      schemaVersion: 1,
      totalCount: 3,
      firms: { state: 'ok', partial: false, count: 3, rows: 3, newestDetectedAt: NOW, oldestDetectedAt: NOW },
      byCountry: { US: [{ brightness: 400, frp: 60 }, null, { brightness: 'x', frp: 1 }], ZZ: 'rows' },
    });
    assert.deepEqual(parsed?.byCountry, { US: [{ brightness: 400, frp: 60 }, { brightness: 0, frp: 1 }] });
  });
});

describe('summary key names', () => {
  it('pins the seed-meta key the shared helpers derive from the data key', () => {
    assert.equal(WILDFIRE_FIRES_SUMMARY_KEY, 'wildfire:fires-summary:v1');
    assert.equal(WILDFIRE_FIRES_SUMMARY_META_KEY, 'seed-meta:wildfire:fires-summary');
    assert.equal(WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY, 'seed-activated:wildfire:fires-summary');
  });
});
