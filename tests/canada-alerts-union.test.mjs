import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANADA_ALERTS_KEY,
  CANADA_ALERTS_MAX_PUBLISHED,
  CANADA_ALERT_SOURCES,
  buildCanadaAlertsUnion,
  rebuildCanadaAlertsUnion,
} from '../scripts/lib/canada-alerts-union.mjs';

const UNION_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/lib/canada-alerts-union.mjs'),
  'utf8',
);

const NOW = 1_786_960_000_000;

const ab = {
  id: 'same-id', province: 'AB', severity: 'Moderate', updatedAt: NOW - 2_000,
};
const bc = {
  id: 'same-id', province: 'BC', severity: 'Extreme', updatedAt: NOW - 1_000,
};
const sk = {
  id: 'same-id', province: 'SK', severity: 'Severe', updatedAt: NOW - 500,
};

test('unions province snapshots without collapsing IDs from different provinces', () => {
  const result = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts: [ab] }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: { alerts: [bc] }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[2], snapshot: { alerts: [sk] }, meta: { fetchedAt: NOW - 60_000 } },
  ], NOW);

  assert.deepEqual(result.alerts, [bc, sk, ab]);
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
    [CANADA_ALERT_SOURCES[2].key, { alerts: [sk] }],
    [CANADA_ALERT_SOURCES[0].metaKey, { fetchedAt: NOW - 60_000 }],
    [CANADA_ALERT_SOURCES[1].metaKey, { fetchedAt: NOW - 60_000 }],
    [CANADA_ALERT_SOURCES[2].metaKey, { fetchedAt: NOW - 60_000 }],
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

  assert.equal(result.alerts.length, 3);
  assert.equal(calls[0][0], 'data');
  assert.equal(calls[0][1], CANADA_ALERTS_KEY);
  assert.equal(calls[0][2].alerts.length, 3);
  assert.equal(calls[0][4].recordCount, 3);
  assert.equal(calls[1][0], 'meta');
  assert.equal(calls[1][1], 'alerts');
  assert.equal(calls[1][2], 'canada-union');
});

test('uses the current source directly and reads only its peers', async () => {
  const reads = [];
  const calls = [];
  const abSource = CANADA_ALERT_SOURCES[0];
  const bcSource = CANADA_ALERT_SOURCES[1];
  const skSource = CANADA_ALERT_SOURCES[2];
  const peerSnapshots = new Map([
    [abSource.key, { alerts: [ab] }],
    [abSource.metaKey, { fetchedAt: NOW - 60_000, sourceState: 'ok' }],
    [skSource.key, { alerts: [sk] }],
    [skSource.metaKey, { fetchedAt: NOW - 60_000, sourceState: 'ok' }],
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

  assert.deepEqual(reads.sort(), [abSource.key, abSource.metaKey, skSource.key, skSource.metaKey].sort());
  assert.equal(reads.includes(bcSource.key), false);
  assert.equal(reads.includes(bcSource.metaKey), false);
  assert.deepEqual(result.degradedSources, ['BC']);
  assert.deepEqual(calls[1][8].degradedSources, ['BC']);
});

test('caps published union alerts at 200', () => {
  const alerts = Array.from({ length: CANADA_ALERTS_MAX_PUBLISHED + 1 }, (_, index) => ({
    id: `ab-${index}`,
    province: 'AB',
    severity: index === 0 ? 'Extreme' : 'Minor',
    updatedAt: NOW - index,
  }));
  const result = buildCanadaAlertsUnion([
    { source: CANADA_ALERT_SOURCES[0], snapshot: { alerts }, meta: { fetchedAt: NOW - 60_000 } },
    { source: CANADA_ALERT_SOURCES[1], snapshot: { alerts: [] }, meta: { fetchedAt: NOW - 60_000 } },
  ], NOW);

  assert.equal(result.alerts.length, CANADA_ALERTS_MAX_PUBLISHED);
  assert.equal(result.alerts[0].id, 'ab-0');
});

test('preserves last-good union when a province snapshot is missing', async () => {
  const existing = { alerts: [ab, bc] };
  const writes = [];
  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    currentSource: { province: 'AB', snapshot: { alerts: [ab] } },
    readSnapshot: async (key) => {
      if (key === CANADA_ALERTS_KEY) return existing;
      return null;
    },
    writeKey: async (...args) => writes.push(['data', ...args]),
    writeMeta: async (...args) => writes.push(['meta', ...args]),
    extendTtl: async (...args) => {
      writes.push(['ttl', ...args]);
      return true;
    },
  });

  assert.equal(result.preserved, true);
  assert.deepEqual(result.missingSources, ['BC', 'SK']);
  assert.equal(writes[0][0], 'ttl');
  assert.deepEqual(writes[0][1], [CANADA_ALERTS_KEY]);
  assert.equal(writes[1][0], 'meta');
  assert.equal(writes[1][3], 2);
  assert.equal(writes[1][8].preserved, true);
  assert.equal(writes.some((call) => call[0] === 'data'), false);
});

test('publishes a partial union on first run when no prior union exists', async () => {
  const writes = [];
  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    currentSource: { province: 'AB', snapshot: { alerts: [ab] } },
    readSnapshot: async () => null,
    writeKey: async (...args) => writes.push(['data', ...args]),
    writeMeta: async (...args) => writes.push(['meta', ...args]),
    extendTtl: async () => { throw new Error('should not extend TTL without a prior union'); },
  });

  assert.equal(result.preserved, false);
  assert.equal(writes[0][0], 'data');
  assert.deepEqual(writes[0][2], { alerts: [ab] });
  assert.equal(writes[1][0], 'meta');
  assert.equal(writes[1][8].preserved, undefined);
});

test('still publishes when a present peer is only CAP-degraded', async () => {
  const writes = [];
  const abSource = CANADA_ALERT_SOURCES[0];
  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    currentSource: {
      province: 'BC',
      snapshot: { alerts: [bc] },
    },
    readSnapshot: async (key) => {
      if (key === abSource.key) return { alerts: [ab] };
      if (key === abSource.metaKey) return { fetchedAt: NOW - 60_000, sourceState: 'degraded' };
      if (key === CANADA_ALERT_SOURCES[2].key) return { alerts: [sk] };
      if (key === CANADA_ALERT_SOURCES[2].metaKey) return { fetchedAt: NOW - 60_000, sourceState: 'ok' };
      throw new Error(`unexpected read ${key}`);
    },
    writeKey: async (...args) => writes.push(['data', ...args]),
    writeMeta: async (...args) => writes.push(['meta', ...args]),
    extendTtl: async () => { throw new Error('CAP-only degradation must still publish'); },
  });

  assert.equal(result.preserved, false);
  assert.deepEqual(result.degradedSources, ['AB']);
  assert.equal(writes[0][0], 'data');
  assert.equal(writes[0][2].alerts.length, 3);
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

test('rewrites the union when last-good TTL extend does not confirm', async () => {
  const existing = { alerts: [ab, bc] };
  const writes = [];
  const result = await rebuildCanadaAlertsUnion({
    nowMs: NOW,
    currentSource: { province: 'AB', snapshot: { alerts: [ab] } },
    readSnapshot: async (key) => {
      if (key === CANADA_ALERTS_KEY) return existing;
      return null;
    },
    writeKey: async (...args) => writes.push(['data', ...args]),
    writeMeta: async (...args) => writes.push(['meta', ...args]),
    extendTtl: async (...args) => {
      writes.push(['ttl', ...args]);
      return false;
    },
  });

  assert.equal(result.preserved, false);
  assert.equal(writes[0][0], 'ttl');
  assert.equal(writes[1][0], 'data');
  assert.deepEqual(writes[1][2], { alerts: [ab] });
  assert.equal(writes[2][0], 'meta');
  assert.equal(writes[2][8].preserved, undefined);
});

test('defaults union metadata writes to the non-throwing seed-meta helper', () => {
  assert.match(UNION_SOURCE, /writeMeta = writeFreshnessMetadataSafely/);
  assert.match(UNION_SOURCE, /import \{[\s\S]*writeFreshnessMetadataSafely[\s\S]*\} from '\.\.\/_seed-utils\.mjs'/);
});
