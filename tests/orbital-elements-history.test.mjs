// The R2 elements history (#9110) keeps one entry per satellite per epoch for 30 days, and the
// catalog seeder never lets an R2 problem fail the catalog or replace history it cannot read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { HISTORY_DAYS, HISTORY_SCHEMA, mergeHistory } from '../scripts/_orbital-history.mjs';
import { selectProfiledSatellites } from '../scripts/_orbital-catalog.mjs';
import { updateElementsHistory } from '../scripts/seed-orbital-catalog.mjs';

const DAY_MS = 86_400_000;
const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
const SATELLITES = selectProfiledSatellites(records);
const NOW = Date.parse('2026-11-13T09:00:00Z');

const withEpoch = (satellite, iso) => ({ ...satellite, elements: { ...satellite.elements, EPOCH: iso } });

describe('mergeHistory', () => {
  it('starts a history with one entry per satellite', () => {
    const { history, added, changed } = mergeHistory(null, SATELLITES, NOW);
    assert.equal(history.schema, HISTORY_SCHEMA);
    assert.equal(history.windowDays, HISTORY_DAYS);
    assert.equal(history.updatedAt, NOW);
    assert.equal(added, SATELLITES.length);
    assert.equal(changed, true);
    assert.deepEqual(Object.keys(history.entries[0]).sort(), ['bstar', 'eccentricity', 'epoch', 'inclination', 'meanMotion', 'noradId', 'raan']);
  });

  it('adds only epochs it does not hold, ordered by satellite then epoch', () => {
    const first = mergeHistory(null, SATELLITES, NOW).history;
    const again = mergeHistory(first, SATELLITES, NOW + 3_600_000);
    assert.equal(again.added, 0);
    assert.equal(again.changed, false);

    const moved = withEpoch(SATELLITES[0], '2026-11-12T22:00:00.000000');
    const next = mergeHistory(first, [moved, ...SATELLITES.slice(1)], NOW + 3_600_000);
    assert.equal(next.added, 1);
    const own = next.history.entries.filter((e) => e.noradId === SATELLITES[0].noradId);
    assert.equal(own.length, 2);
    assert.ok(own[0].epoch < own[1].epoch);
    assert.ok(next.history.entries.every((e, i, all) => i === 0 || all[i - 1].noradId < e.noradId || (all[i - 1].noradId === e.noradId && all[i - 1].epoch < e.epoch)));
  });

  it('drops entries older than the window, and ignores epochs outside it', () => {
    const stale = { noradId: 1, epoch: NOW - (HISTORY_DAYS + 1) * DAY_MS, meanMotion: 15, eccentricity: 0.001, inclination: 97, raan: 10, bstar: 0 };
    const kept = { ...stale, epoch: NOW - (HISTORY_DAYS - 1) * DAY_MS };
    const previous = { schema: HISTORY_SCHEMA, windowDays: HISTORY_DAYS, updatedAt: 0, entries: [stale, kept] };
    const old = withEpoch(SATELLITES[0], '2026-09-01T00:00:00');
    const future = withEpoch(SATELLITES[1], '2026-12-01T00:00:00');
    const result = mergeHistory(previous, [old, future], NOW);
    assert.equal(result.pruned, 1);
    assert.equal(result.added, 0);
    assert.equal(result.changed, true);
    assert.deepEqual(result.history.entries, [kept]);
  });

  it('refuses a stored object it did not write', () => {
    assert.throws(() => mergeHistory({ schema: 2, entries: [] }, SATELLITES, NOW), /unreadable shape/);
    assert.throws(() => mergeHistory({ schema: HISTORY_SCHEMA }, SATELLITES, NOW), /unreadable shape/);
    assert.throws(() => mergeHistory('[]', SATELLITES, NOW), /unreadable shape/);
  });

  it('refuses a stored history with any entry it cannot read, rather than dropping it', () => {
    const good = { noradId: 1, epoch: NOW - DAY_MS, meanMotion: 15, eccentricity: 0.001, inclination: 97, raan: 10, bstar: null };
    const stored = (bad) => ({ schema: HISTORY_SCHEMA, windowDays: HISTORY_DAYS, updatedAt: 0, entries: [good, bad] });
    for (const bad of [{ ...good, epoch: '2026-11-10T00:00:00Z' }, { ...good, inclination: null }, { ...good, noradId: '1' }, null]) {
      assert.throws(() => mergeHistory(stored(bad), SATELLITES, NOW), /unreadable entry at index 1/, JSON.stringify(bad));
    }
    assert.equal(mergeHistory(stored({ ...good, epoch: NOW - 2 * DAY_MS }), SATELLITES, NOW).history.entries.filter((e) => e.noradId === 1).length, 2);
  });

  it('stays near the size the plan expects for 30 days', () => {
    // 297 profiled satellites; LEO imagers get about two new element sets a day.
    let history = null;
    const many = Array.from({ length: 297 }, (_, i) => ({ ...SATELLITES[i % SATELLITES.length], elements: { ...SATELLITES[i % SATELLITES.length].elements, NORAD_CAT_ID: 90_000 + i } }));
    for (let half = 0; half < HISTORY_DAYS * 2; half++) {
      const iso = new Date(NOW - (HISTORY_DAYS * DAY_MS) + half * DAY_MS / 2 + 1).toISOString().replace('Z', '');
      history = mergeHistory(history, many.map((s) => withEpoch(s, iso)), NOW).history;
    }
    const bytes = Buffer.byteLength(JSON.stringify(history));
    assert.equal(history.entries.length, 297 * HISTORY_DAYS * 2);
    assert.ok(bytes < 3_000_000, `history is ${bytes} bytes`);
  });
});

describe('updateElementsHistory', () => {
  const catalog = { satellites: SATELLITES };
  const config = { mode: 'api' };

  it('skips without R2 config', async () => {
    let reads = 0;
    const result = await updateElementsHistory(catalog, { storageConfig: null, readHistory: async () => { reads++; return null; } });
    assert.equal(result.status, 'skipped-unconfigured');
    assert.equal(reads, 0);
  });

  it('writes the merged history', async () => {
    const writes = [];
    const result = await updateElementsHistory(catalog, {
      storageConfig: config, nowMs: NOW, readHistory: async () => null, writeHistory: async (c, h) => { writes.push([c, h]); },
    });
    assert.equal(result.status, 'written');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], config);
    assert.equal(writes[0][1].entries.length, SATELLITES.length);
  });

  it('does not write when nothing changed', async () => {
    const stored = mergeHistory(null, SATELLITES, NOW).history;
    let writes = 0;
    const result = await updateElementsHistory(catalog, {
      storageConfig: config, nowMs: NOW + 60_000, readHistory: async () => stored, writeHistory: async () => { writes++; },
    });
    assert.equal(result.status, 'unchanged');
    assert.equal(writes, 0);
  });

  it('gives up at its own budget when R2 stalls, so the catalog job keeps its time limit', async () => {
    let writes = 0;
    const started = Date.now();
    const result = await updateElementsHistory(catalog, {
      storageConfig: config, nowMs: NOW, budgetMs: 50, readHistory: () => new Promise(() => {}), writeHistory: async () => { writes++; },
    });
    assert.equal(result.status, 'skipped-error');
    assert.match(result.error, /timed out after 50ms/);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(writes, 0);
  });

  it('does not write back a read that outlived the budget', async () => {
    let now = 0;
    let writes = 0;
    const result = await updateElementsHistory(catalog, {
      storageConfig: config, nowMs: NOW, budgetMs: 25_000, clock: () => now,
      readHistory: async () => { now = 30_000; return null; }, writeHistory: async () => { writes++; },
    });
    assert.equal(result.status, 'skipped-error');
    assert.match(result.error, /outlived/);
    assert.equal(writes, 0);
  });

  it('never writes after a failed or unreadable read, and never throws', async () => {
    const isoEpochs = { schema: HISTORY_SCHEMA, windowDays: HISTORY_DAYS, updatedAt: 0, entries: [{ noradId: 1, epoch: '2026-11-10T00:00:00Z', meanMotion: 15, eccentricity: 0.001, inclination: 97, raan: 10, bstar: 0 }] };
    for (const readHistory of [async () => { throw new Error('R2 get failed: HTTP 503'); }, async () => ({ schema: 99, entries: [] }), async () => isoEpochs]) {
      let writes = 0;
      const result = await updateElementsHistory(catalog, { storageConfig: config, nowMs: NOW, readHistory, writeHistory: async () => { writes++; } });
      assert.equal(result.status, 'skipped-error');
      assert.equal(writes, 0);
    }
    const failedWrite = await updateElementsHistory(catalog, {
      storageConfig: config, nowMs: NOW, readHistory: async () => null, writeHistory: async () => { throw new Error('R2 put failed'); },
    });
    assert.equal(failedWrite.status, 'skipped-error');
  });
});
