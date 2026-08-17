import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANADA_ALERTS_KEY,
  CANADA_ALERT_SOURCES,
  buildCanadaAlertsUnion,
  rebuildCanadaAlertsUnion,
} from '../scripts/lib/canada-alerts-union.mjs';

const NOW = 1_786_960_000_000;

const ab = {
  id: 'same-id', province: 'AB', severity: 'Moderate', updatedAt: NOW - 2_000,
};
const bc = {
  id: 'same-id', province: 'BC', severity: 'Extreme', updatedAt: NOW - 1_000,
};

test('unions province snapshots without collapsing IDs from different provinces', () => {
  const result = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts: [ab] }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: { alerts: [bc] }, meta: { fetchedAt: NOW - 60_000 } },
  ], NOW);

  assert.deepEqual(result.alerts, [bc, ab]);
  assert.deepEqual(result.missingSources, []);
  assert.deepEqual(result.degradedSources, []);
  assert.equal(result.sourceState, 'ok');
});

test('marks the union degraded when a configured source is missing or stale', () => {
  const result = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts: [ab] }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: null, meta: null },
  ], NOW);
  assert.deepEqual(result.alerts, [ab]);
  assert.deepEqual(result.missingSources, ['BC']);
  assert.equal(result.sourceState, 'degraded');
  assert.equal(result.errorCode, 'CANADA_ALERT_SOURCE_MISSING');

  const stale = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts: [ab] }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: { alerts: [] }, meta: { fetchedAt: NOW - 46 * 60_000 } },
  ], NOW);
  assert.deepEqual(stale.staleSources, ['BC']);
  assert.equal(stale.errorCode, 'CANADA_ALERT_SOURCE_STALE');

  const degraded = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts: [ab] }, meta: { fetchedAt: NOW - 60_000, sourceState: 'degraded' } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: { alerts: [] }, meta: { fetchedAt: NOW - 60_000, sourceState: 'ok' } },
  ], NOW);
  assert.deepEqual(degraded.degradedSources, ['AB']);
  assert.equal(degraded.errorCode, 'CANADA_ALERT_SOURCE_DEGRADED');
});

test('publishes the aggregate envelope before its health metadata', async () => {
  const calls = [];
  const snapshots = new Map([
    [CANADA_ALERT_SOURCES[0].key, { alerts: [ab] }],
    [CANADA_ALERT_SOURCES[1].key, { alerts: [bc] }],
    [CANADA_ALERT_SOURCES[0].metaKey, { fetchedAt: NOW - 60_000 }],
    [CANADA_ALERT_SOURCES[1].metaKey, { fetchedAt: NOW - 60_000 }],
  ]);

  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    readSnapshot: async (key, options) => {
      assert.deepEqual(options, { strict: true });
      return snapshots.get(key) ?? null;
    },
    writeKey: async (...args) => calls.push(['data', ...args]),
    writeMeta: async (...args) => calls.push(['meta', ...args]),
  });

  assert.equal(result.alerts.length, 2);
  assert.equal(calls[0][0], 'data');
  assert.equal(calls[0][1], CANADA_ALERTS_KEY);
  assert.equal(calls[0][2].alerts.length, 2);
  assert.equal(calls[0][4].recordCount, 2);
  assert.equal(calls[1][0], 'meta');
  assert.equal(calls[1][1], 'alerts');
  assert.equal(calls[1][2], 'canada-union');
});

test('uses the current source directly and reads only its peer', async () => {
  const reads = [];
  const calls = [];
  const abSource = CANADA_ALERT_SOURCES[0];
  const bcSource = CANADA_ALERT_SOURCES[1];
  const peerSnapshots = new Map([
    [abSource.key, { alerts: [ab] }],
    [abSource.metaKey, { fetchedAt: NOW - 60_000, sourceState: 'ok' }],
  ]);

  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    currentSource: {
      province: 'BC',
      snapshot: { alerts: [bc] },
      metaPatch: { sourceState: 'degraded' },
    },
    readSnapshot: async (key, options) => {
      reads.push(key);
      assert.deepEqual(options, { strict: true });
      return peerSnapshots.get(key) ?? null;
    },
    writeKey: async (...args) => calls.push(['data', ...args]),
    writeMeta: async (...args) => calls.push(['meta', ...args]),
  });

  assert.deepEqual(reads.sort(), [abSource.key, abSource.metaKey].sort());
  assert.equal(reads.includes(bcSource.key), false);
  assert.equal(reads.includes(bcSource.metaKey), false);
  assert.deepEqual(result.degradedSources, ['BC']);
  assert.deepEqual(calls[1][8].degradedSources, ['BC']);
});

test('propagates strict peer read failures without publishing an aggregate', async () => {
  const writes = [];
  await assert.rejects(
    rebuildCanadaAlertsUnion({
      nowMs: NOW,
      currentSource: { province: 'BC', snapshot: { alerts: [bc] } },
      readSnapshot: async () => { throw new Error('synthetic strict read failure'); },
      writeKey: async (...args) => writes.push(['data', ...args]),
      writeMeta: async (...args) => writes.push(['meta', ...args]),
    }),
    /synthetic strict read failure/,
  );
  assert.deepEqual(writes, []);
});
