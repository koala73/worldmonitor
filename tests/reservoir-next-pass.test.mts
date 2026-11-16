import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findPasses, parseOrbitElements, type OmmRecord } from '../shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES } from '../shared/orbital/sensor-profiles.js';
import type { OrbitalCatalog } from '../src/services/orbital/catalog-shape.ts';
import { computeReservoirNextPasses, ICESAT2_PROFILE_ID } from '../src/services/orbital/reservoir-next-pass.ts';
import { STRATEGIC_RESERVOIR_SITES, isDamRelated, reservoirAtSite } from '../src/services/climate/reservoir-context.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-14.json', import.meta.url), 'utf8'));
const icesat: OmmRecord = fixture.records.find((r: OmmRecord) => r.OBJECT_NAME === 'ICESAT-2');
const epochMs = parseOrbitElements(icesat).epochMs;
const catalog = (records: OmmRecord[]): OrbitalCatalog => ({
  status: 'ok' as OrbitalCatalog['status'],
  fetchedAt: epochMs,
  inventoryVersion: 'fixture',
  satellites: records.length ? [{ noradId: 43613, name: 'ICESAT-2', profileId: ICESAT2_PROFILE_ID, elementSets: records }] : [],
});

describe('reservoir next ICESat-2 crossing', () => {
  it('answers for every strategic reservoir, with crossings and normal no-crossing answers', () => {
    assert.equal(STRATEGIC_RESERVOIR_SITES.length, 50);
    const passes = computeReservoirNextPasses(catalog([icesat]), STRATEGIC_RESERVOIR_SITES, epochMs)!;
    assert.equal(passes.size, 50);
    const statuses = [...passes.values()].map(p => p.status);
    assert.ok(statuses.includes('pass'), 'a week of ground track crosses some lakes');
    assert.ok(statuses.includes('none'), 'and misses others, which is a normal answer');
    for (const pass of passes.values()) {
      assert.equal(pass.elementsEpochMs, epochMs);
      if (pass.status === 'pass') assert.ok(pass.timeMs >= epochMs && pass.timeMs <= pass.windowEndMs);
    }
  });

  it('agrees with the shared pass geometry on each predicted crossing', () => {
    const elements = parseOrbitElements(icesat);
    const profile = SENSOR_PROFILES.find(p => p.id === ICESAT2_PROFILE_ID)!;
    const passes = computeReservoirNextPasses(catalog([icesat]), STRATEGIC_RESERVOIR_SITES, epochMs)!;
    let checked = 0;
    for (const site of STRATEGIC_RESERVOIR_SITES) {
      const ours = passes.get(site.id)!;
      if (ours.status !== 'pass') continue;
      const [w, s, e, n] = site.core;
      const point = { lat: (s + n) / 2, lon: (w + e) / 2 };
      const halfDiagonalKm = Math.hypot((e - w) * 111.32 * Math.cos(point.lat * Math.PI / 180), (n - s) * 111.32) / 2;
      const result = findPasses({ elements, profile, point, window: { start: epochMs, end: epochMs + 7 * 86_400_000 }, now: epochMs });
      const match = result.passes.find(p => Math.abs(p.timeMs - ours.timeMs) < 5 * 60_000);
      assert.ok(match, `${site.id}: findPasses sees the same overflight`);
      assert.ok(match.groundDistanceKm <= halfDiagonalKm + 15, `${site.id}: ${match.groundDistanceKm} km from the lake centre`);
      checked++;
    }
    assert.ok(checked > 0);
  });

  it('gives no answer without ICESat-2 elements or with stale ones', () => {
    assert.equal(computeReservoirNextPasses(catalog([]), STRATEGIC_RESERVOIR_SITES, epochMs), null);
    assert.equal(computeReservoirNextPasses(catalog([icesat]), STRATEGIC_RESERVOIR_SITES, epochMs + 30 * 86_400_000), null);
  });
});

describe('reservoir at a dam-related event site', () => {
  const kakhovka = STRATEGIC_RESERVOIR_SITES.find(site => site.id === 'kakhovka')!;
  const [w, s, e, n] = kakhovka.core;
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;

  it('matches an event that names a dam inside the lake extent', () => {
    assert.equal(reservoirAtSite(lat, lon, 'Strike near the Kakhovka dam')?.id, 'kakhovka');
    assert.equal(reservoirAtSite(lat, lon, 'Shelling of hydroelectric plant')?.id, 'kakhovka');
  });

  it('ignores events that are not about a dam or are away from any reservoir', () => {
    assert.equal(reservoirAtSite(lat, lon, 'Artillery exchange reported'), null);
    assert.equal(reservoirAtSite(0, -30, 'Dam breach'), null);
    assert.equal(reservoirAtSite(Number.NaN, lon, 'Dam breach'), null);
    assert.equal(isDamRelated('Amsterdam protest'), false);
  });
});
