import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GDELT_BULK_ARTICLES_KEY,
  GDELT_BULK_CONFLICT_KEY,
  GDELT_BULK_UNREST_KEY,
} from '../scripts/_gdelt-bulk-contract.mjs';
import {
  GDELT_BULK_MAX_EXPORT_AGE_MS,
  GDELT_BULK_MAX_FUTURE_SKEW_MS as CONFLICT_MAX_FUTURE_SKEW_MS,
  readMaterializedGdeltConflictEvents,
} from '../scripts/seed-conflict-intel.mjs';
import {
  GDELT_BULK_MAX_FUTURE_SKEW_MS as UNREST_MAX_FUTURE_SKEW_MS,
  GDELT_BULK_UNREST_MAX_AGE_MS,
  readMaterializedGdeltEvents,
} from '../scripts/seed-unrest-events.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('GDELT bulk materializer deployment contract', () => {
  it('runs the materializer on the existing 15-minute GDELT Railway service without proxy credentials', () => {
    const services = JSON.parse(read('scripts/railway-services.json'));
    const materializer = services.find((service) =>
      service.entry === 'scripts/seed-gdelt-bulk-materializer.mjs');

    assert.ok(materializer, 'bulk materializer must be registered');
    assert.equal(materializer.service, 'seed-gdelt-intel');
    assert.equal(materializer.cronSchedule, '*/15 * * * *');
    assert.deepEqual(materializer.requiredEnv, [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ]);
    assert.ok(materializer.watchPatterns.includes('scripts/_gdelt-bulk-contract.mjs'));
    assert.ok(materializer.watchPatterns.includes('scripts/_gdelt-bulk-materializer.mjs'));
    assert.equal(
      services.some((service) => service.entry === 'scripts/seed-gdelt-intel.mjs'),
      false,
      'the DOC seeder must no longer be an active Railway service',
    );
  });
});

describe('GDELT consumers read materialized Redis products', () => {
  it('conflict accepts the exact export-age boundary and preserves its source timestamp', async () => {
    const nowMs = Date.parse('2026-07-30T15:00:00.000Z');
    const snapshot = {
      source: 'gdelt-bulk',
      fetchedAt: '2026-07-30T12:00:00.000Z',
      events: [{ id: 'gdelt-conflict-1', title: 'Materialized conflict event' }],
      pagination: { exportTimestamp: '20260730120000' },
    };

    assert.strictEqual(
      await readMaterializedGdeltConflictEvents({
        readSnapshot: async () => snapshot,
        now: () => nowMs,
      }),
      snapshot,
    );
    assert.equal(
      nowMs - Date.UTC(2026, 6, 30, 12),
      GDELT_BULK_MAX_EXPORT_AGE_MS,
    );
  });

  it('conflict rejects stale, future-skewed, and malformed materialized snapshots', async () => {
    const nowMs = Date.parse('2026-07-30T15:00:00.000Z');
    const snapshot = {
      source: 'gdelt-bulk',
      events: [{ id: 'gdelt-conflict-1', title: 'Materialized conflict event' }],
    };

    await assert.rejects(
      readMaterializedGdeltConflictEvents({
        readSnapshot: async () => ({
          ...snapshot,
          pagination: { exportTimestamp: '20260730114500' },
        }),
        now: () => nowMs,
      }),
      /stale/,
    );
    await assert.rejects(
      readMaterializedGdeltConflictEvents({
        readSnapshot: async () => ({
          ...snapshot,
          pagination: { exportTimestamp: '20260730150600' },
        }),
        now: () => nowMs,
      }),
      /future/,
    );
    assert.equal(CONFLICT_MAX_FUTURE_SKEW_MS, 5 * 60 * 1000);
    await assert.rejects(
      readMaterializedGdeltConflictEvents({
        readSnapshot: async () => ({ source: 'gdelt-bulk', events: [] }),
        now: () => nowMs,
      }),
      new RegExp(`${GDELT_BULK_CONFLICT_KEY} missing or empty`),
    );

    const source = read('scripts/seed-conflict-intel.mjs');
    assert.equal(GDELT_BULK_CONFLICT_KEY, 'gdelt:bulk:conflict-events:v1');
    assert.match(
      source,
      /fetchGdeltFallback = readMaterializedGdeltConflictEvents/,
      'the production no-credentials fallback must stay wired to the tested reader',
    );
  });

  it('unrest accepts the exact product-age boundary and preserves its fetchedAt', async () => {
    const nowMs = Date.parse('2026-07-30T15:00:00.000Z');
    const events = [{ id: 'gdelt-unrest-1', title: 'Materialized unrest event' }];
    const snapshot = {
      events,
      fetchedAt: nowMs - GDELT_BULK_UNREST_MAX_AGE_MS,
    };

    assert.strictEqual(
      await readMaterializedGdeltEvents({
        _readSnapshot: async () => snapshot,
        _now: () => nowMs,
      }),
      snapshot,
    );
  });

  it('unrest rejects stale, future-skewed, and malformed materialized snapshots', async () => {
    const nowMs = Date.parse('2026-07-30T15:00:00.000Z');
    const events = [{ id: 'gdelt-unrest-1', title: 'Materialized unrest event' }];

    await assert.rejects(
      readMaterializedGdeltEvents({
        _readSnapshot: async () => ({
          events,
          fetchedAt: nowMs - GDELT_BULK_UNREST_MAX_AGE_MS - 1,
        }),
        _now: () => nowMs,
      }),
      /stale/,
    );
    await assert.rejects(
      readMaterializedGdeltEvents({
        _readSnapshot: async () => ({
          events,
          fetchedAt: nowMs + UNREST_MAX_FUTURE_SKEW_MS + 1,
        }),
        _now: () => nowMs,
      }),
      /future/,
    );
    await assert.rejects(
      readMaterializedGdeltEvents({
        _readSnapshot: async () => ({ events: 'not-an-array' }),
        _now: () => nowMs,
      }),
      new RegExp(`${GDELT_BULK_UNREST_KEY} missing or malformed`),
    );

    const source = read('scripts/seed-unrest-events.mjs');
    assert.equal(GDELT_BULK_UNREST_KEY, 'gdelt:bulk:unrest-events:v1');
    assert.match(
      source,
      /Promise\.allSettled\(\[[\s\S]*readMaterializedGdeltEvents\(\)/,
      'the production unrest merge must stay wired to the tested reader',
    );
    assert.match(
      source,
      /gdeltSnapshot\?\.events/,
      'the production merge must consume the timestamp-gated snapshot',
    );
  });

  it('the relay no longer owns a direct GDELT positive-events loop', () => {
    const source = read('scripts/ais-relay.cjs');
    const startup = source.slice(source.indexOf('server.listen(PORT'));
    assert.doesNotMatch(startup, /\bstartPositiveEventsSeedLoop\(\)/);
  });

  it('the recall benchmark reads the bulk article index instead of issuing DOC queries', () => {
    const source = read('scripts/seed-recall-benchmark.mjs');
    assert.equal(GDELT_BULK_ARTICLES_KEY, 'gdelt:bulk:articles:v1');
    assert.match(source, /GDELT_BULK_ARTICLES_KEY/);
    assert.doesNotMatch(source, /fetchGdeltJson|api\.gdeltproject\.org/);
  });
});
