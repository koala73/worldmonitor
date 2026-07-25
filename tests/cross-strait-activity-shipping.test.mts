import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY,
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES,
  CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
  CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY,
  CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS,
  CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS,
  CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS,
  projectCrossStraitActivityBootstrap,
  writePublicationCompletion,
} from '../scripts/seed-cross-strait-activity.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function observation(sourceId: string, reportingDay: string, history = []) {
  return {
    id: `${sourceId}:${reportingDay}`,
    sourceId,
    observationKind: sourceId === 'japan-mod' ? 'reviewed_regional_augmentation' : 'daily_activity_report',
    reportingDay,
    reportingPeriod: { end: `${reportingDay}T06:00:00+08:00` },
    revision: { sequence: 2 },
    history,
  };
}

test('cross-Strait bootstrap is a bounded current projection, not the durable revision archive', () => {
  const snapshot = {
    schemaVersion: 1,
    generatedAt: '2026-07-25T12:00:00.000Z',
    status: 'degraded',
    sources: [{ id: 'taiwan-mnd', transportStatus: 'error' }, { id: 'japan-mod', transportStatus: 'fresh' }],
    coverage: { latestMndReportingDay: '2026-07-25' },
    observations: [
      observation('taiwan-mnd', '2026-07-24', [{ obsolete: true }]),
      observation('taiwan-mnd', '2026-07-25', [{ corrected: true }]),
      observation('japan-mod', '2026-07-20', [{ reviewed: true }]),
      { ...observation('japan-mod', '2026-07-19'), observationKind: 'unreviewed_candidate' },
    ],
    baselines: { sourceId: 'taiwan-mnd' },
  };

  const projection = projectCrossStraitActivityBootstrap(snapshot);
  assert.equal(CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY, 'military:cross-strait-activity-bootstrap:v1');
  assert.deepEqual(projection.observations.map((row) => row.id), [
    'taiwan-mnd:2026-07-25',
    'japan-mod:2026-07-20',
  ]);
  assert.ok(projection.observations.every((row) => !('history' in row)));
  assert.deepEqual(projection.sources, snapshot.sources);
  assert.deepEqual(projection.coverage, snapshot.coverage);
  assert.deepEqual(projection.baselines, snapshot.baselines);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES);
  assert.throws(
    () => projectCrossStraitActivityBootstrap({ ...snapshot, sources: [{ padding: 'x'.repeat(CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES) }] }),
    /bootstrap projection is .* bytes; maximum is/,
  );
});

test('cross-Strait source transport health degrades immediately without discarding last-good records', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS } = __testing__;
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  for (const name of ['crossStraitActivityTaiwanMnd', 'crossStraitActivityJapanMod']) {
    const dataKey = STANDALONE_KEYS[name];
    const metaKey = SEED_META[name].key;
    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 91,
        sourceState: 'error',
        stale: true,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });

    assert.equal(entry.status, 'SEED_ERROR', name);
    assert.equal(entry.records, 91, name);
  }
});

test('health monitors the compact activity projection independently of the durable archive', () => {
  const { classifyKey, BOOTSTRAP_KEYS, SEED_META } = __testing__;
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const dataKey = BOOTSTRAP_KEYS.crossStraitActivityBootstrap;
  const metaKey = SEED_META.crossStraitActivityBootstrap.key;
  assert.equal(dataKey, CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY);
  assert.equal(metaKey, CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY);

  const context = (bootstrapBytes: number, meta?: object) => ({
    keyStrens: new Map([
      [BOOTSTRAP_KEYS.crossStraitActivity, 2_000_000],
      [dataKey, bootstrapBytes],
    ]),
    keyErrors: new Map(),
    keyMetaValues: new Map(meta ? [[metaKey, JSON.stringify(meta)]] : []),
    keyMetaErrors: new Map(),
    now,
  });
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(64_000, { fetchedAt: now - 60_000, recordCount: 3 }),
    ).status,
    'OK',
  );
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(0, { fetchedAt: now - 60_000, recordCount: 3 }),
    ).status,
    'EMPTY',
    'fresh canonical data must not hide a missing UI projection',
  );
  assert.equal(
    classifyKey(
      'crossStraitActivityBootstrap',
      dataKey,
      { allowOnDemand: false },
      context(0),
    ).status,
    'STALE_SEED',
    'the projection remains non-critical before its first successful publish',
  );
});

test('cross-Strait shipping budgets preserve Railway cleanup headroom', () => {
  assert.ok(
    CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS > (
      CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS + CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS
    ),
  );
  assert.match(read('scripts/seed-bundle-derived-signals.mjs'), /maxBundleMs:\s*570_000/);
  assert.match(
    read('scripts/seed-bundle-derived-signals.mjs'),
    new RegExp(`seedMetaKey:\\s*'${CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY.replace('seed-meta:', '')}'`),
  );
  assert.ok(CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS > 310_000);
});

test('cross-Strait completion marker is absent when any source-health write fails', async () => {
  const snapshot = {
    observations: [
      { sourceId: 'taiwan-mnd' },
      { sourceId: 'japan-mod' },
    ],
    sources: [
      {
        id: 'taiwan-mnd',
        transportStatus: 'fresh',
        lastSuccessAt: '2026-07-25T08:00:00.000Z',
      },
      {
        id: 'japan-mod',
        transportStatus: 'fresh',
        lastSuccessAt: '2026-07-25T08:00:00.000Z',
      },
    ],
  };
  const writes: string[] = [];
  const writer = async (key: string) => {
    writes.push(key);
    if (key === 'seed-meta:military:cross-strait-activity:japan-mod') {
      throw new Error('injected source-health failure');
    }
  };
  await assert.rejects(
    writePublicationCompletion(snapshot, writer, Date.parse('2026-07-25T09:00:00.000Z')),
    /injected source-health failure/,
  );
  assert.ok(writes.includes('military:cross-strait-activity:v1:source:taiwan-mnd'));
  assert.ok(writes.includes('military:cross-strait-activity:v1:source:japan-mod'));
  assert.ok(!writes.includes(CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY));
  assert.notEqual(
    CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
    CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY,
    'bundle freshness must not fall back to a projection write',
  );
});

test('cross-Strait completion marker is the final cohort write', async () => {
  const writes: string[] = [];
  await writePublicationCompletion({
    observations: [{ sourceId: 'taiwan-mnd' }],
    sources: [{
      id: 'taiwan-mnd',
      transportStatus: 'fresh',
      lastSuccessAt: '2026-07-25T08:00:00.000Z',
    }],
  }, async (key: string) => {
    writes.push(key);
  }, Date.parse('2026-07-25T09:00:00.000Z'));
  assert.equal(writes.at(-1), CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY);
});
