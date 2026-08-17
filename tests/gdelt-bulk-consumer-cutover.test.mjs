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
    // The default-param pin alone stays green if a stray direct call is added
    // next to it, so forbid the DOC fetcher inside fetchAll's body too
    // (#5863 review — verified mutation-passable without this).
    const conflictSource = read('scripts/seed-conflict-intel.mjs');
    const fetchAllBody = conflictSource.slice(conflictSource.indexOf('export async function fetchAll('));
    assert.doesNotMatch(
      fetchAllBody,
      /\bfetchGdeltConflictEvents\(/,
      'the direct GDELT country sweep must not be called from the production path',
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
    // Scope the guard to the merge array itself and forbid the old direct
    // fetcher INSIDE it. A file-spanning `assert.match` stayed green with
    // fetchGdeltEvents() reinserted alongside the new reader — a wiring guard
    // that cannot fail with the bug restored (#5863 review).
    const unrestMerge = source.match(/Promise\.allSettled\(\[[\s\S]*?\]\)/);
    assert.ok(unrestMerge, 'the production unrest merge array must be locatable');
    assert.match(
      unrestMerge[0],
      /readMaterializedGdeltEvents\(\)/,
      'the production unrest merge must stay wired to the tested reader',
    );
    assert.doesNotMatch(
      unrestMerge[0],
      /\bfetchGdeltEvents\(/,
      'the direct GDELT proxy fetch must not be reactivated in the merge',
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

// #5864: the #5855 cold-start floor must survive the materializer cutover —
// it previously lived only in the now-unwired DOC seam, so a thin cold-start
// snapshot could become the entire conflict feed.
describe('materialized conflict cold-start floor (#5864)', () => {
  const nowMs = Date.parse('2026-07-30T15:00:00.000Z');
  const thin = {
    source: 'gdelt-bulk',
    events: [{ id: 'a', country: 'Sudan' }, { id: 'b', country: 'Sudan' }],
    pagination: { exportTimestamp: '20260730144500', rollingWindowComplete: false },
  };

  it('rejects a thin snapshot while the rolling window is still incomplete', async () => {
    await assert.rejects(
      readMaterializedGdeltConflictEvents({
        readSnapshot: async () => thin,
        now: () => nowMs,
      }),
      /cold-start window too thin: 1 countries/,
    );
  });

  it('accepts a thin snapshot once the rolling window is complete (steady state)', async () => {
    const snapshot = await readMaterializedGdeltConflictEvents({
      readSnapshot: async () => ({ ...thin, pagination: { ...thin.pagination, rollingWindowComplete: true } }),
      now: () => nowMs,
    });
    assert.equal(snapshot.events.length, 2, 'steady-state ticks are never floored');
  });

  it('accepts a cold start that spans enough countries', async () => {
    const snapshot = await readMaterializedGdeltConflictEvents({
      readSnapshot: async () => ({
        ...thin,
        events: [
          { id: 'a', country: 'Sudan' },
          { id: 'b', country: 'Yemen' },
          { id: 'c', country: 'Ukraine' },
        ],
      }),
      now: () => nowMs,
    });
    assert.equal(snapshot.events.length, 3);
  });
});
