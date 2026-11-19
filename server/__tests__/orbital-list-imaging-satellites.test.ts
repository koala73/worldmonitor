import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reads } = vi.hoisted(() => ({ reads: vi.fn() }));
vi.mock('../_shared/redis', () => ({ readCachedJson: reads }));

import { buildCatalog } from '../../scripts/_orbital-catalog.mjs';
import { SENSOR_INVENTORY_VERSION, SENSOR_PROFILES } from '../../shared/orbital/sensor-profiles.js';
import { ORBITAL_CATALOG_KEY } from '../_shared/cache-keys';
import { drainResponseHeaders } from '../_shared/response-headers';
import {
  listImagingSatellites,
  ORBITAL_CATALOG_MAX_STALE_MINUTES,
} from '../worldmonitor/orbital/v1/list-imaging-satellites';

const { records } = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8',
));
const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
const ctx = { request: new Request('https://worldmonitor.test') } as Parameters<typeof listImagingSatellites>[0];

function seededCatalog() {
  const yesterday = buildCatalog({ records, previous: null, nowMs: NOW - DAY });
  return buildCatalog({ records, previous: yesterday, nowMs: NOW });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('listImagingSatellites', () => {
  it('serves current elements, the daily ring and the catalog fetch time from the seeded key', async () => {
    const catalog = seededCatalog();
    reads.mockResolvedValue({ status: 'hit', value: catalog });

    const res = await listImagingSatellites(ctx, {});

    expect(reads).toHaveBeenCalledWith(ORBITAL_CATALOG_KEY, true);
    expect(res.stale).toBe(false);
    expect(res.fetchedAt).toBe(NOW);
    expect(res.source).toBe(catalog.source);
    expect(res.inventoryVersion).toBe(SENSOR_INVENTORY_VERSION);
    expect(res.profiles.map((p) => p.id)).toEqual(SENSOR_PROFILES.map((p) => p.id));
    expect(res.satellites).toHaveLength(catalog.satellites.length);
    const sentinel = res.satellites.find((s) => s.name === 'SENTINEL-2A');
    expect(sentinel).toMatchObject({ noradId: 40697, profileId: 'sentinel-2' });
    expect(sentinel?.elements).toMatchObject({ noradCatId: 40697, objectName: 'SENTINEL-2A' });
    expect(sentinel?.elements?.meanMotion).toBeGreaterThan(14);
    expect(sentinel?.elements?.epoch).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.ring.map((d) => [d.day, d.fetchedAt])).toEqual([
      ['2026-11-12', NOW - DAY],
      ['2026-11-13', NOW],
    ]);
    expect(res.ring[1]?.elements).toHaveLength(res.satellites.length);
    expect(drainResponseHeaders(ctx.request)).toBeUndefined();
  });

  it('returns an empty stale catalog when the key is missing', async () => {
    reads.mockResolvedValue({ status: 'miss', value: null });
    const res = await listImagingSatellites(ctx, {});
    expect(res).toMatchObject({ satellites: [], ring: [], fetchedAt: 0, stale: true });
    expect(res.profiles).toHaveLength(SENSOR_PROFILES.length);
    expect(drainResponseHeaders(ctx.request)).toEqual({ 'X-No-Cache': '1' });
  });

  it('returns an empty stale catalog instead of failing when Redis errors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reads.mockResolvedValue({ status: 'error', value: null, error: new Error('timeout') });
    await expect(listImagingSatellites(ctx, {})).resolves.toMatchObject({ satellites: [], stale: true });
  });

  it('returns an empty stale catalog for a malformed value', async () => {
    reads.mockResolvedValue({ status: 'hit', value: { satellites: 'nope' } });
    await expect(listImagingSatellites(ctx, {})).resolves.toMatchObject({ satellites: [], stale: true });
  });

  it('marks a catalog older than its health freshness limit as stale but still serves it', async () => {
    reads.mockResolvedValue({ status: 'hit', value: seededCatalog() });
    vi.setSystemTime(NOW + (ORBITAL_CATALOG_MAX_STALE_MINUTES + 1) * 60_000);
    const res = await listImagingSatellites(ctx, {});
    expect(res.stale).toBe(true);
    expect(res.satellites.length).toBeGreaterThan(0);
  });

  it('drops satellites the current inventory no longer profiles', async () => {
    const catalog = seededCatalog();
    const stray = { ...catalog.satellites[0], profileId: 'retired', elements: { ...catalog.satellites[0].elements, NORAD_CAT_ID: 1, OBJECT_NAME: 'NOT IMAGING' } };
    reads.mockResolvedValue({ status: 'hit', value: { ...catalog, satellites: [...catalog.satellites, stray] } });
    const res = await listImagingSatellites(ctx, {});
    expect(res.satellites.map((s) => s.noradId)).not.toContain(1);
    expect(res.satellites).toHaveLength(catalog.satellites.length);
  });

  it('uses the same freshness limit as the health check', () => {
    const health = readFileSync(new URL('../../api/health.js', import.meta.url), 'utf8');
    expect(health).toMatch(new RegExp(`orbitalCatalog:\\s*\\{[^}]*maxStaleMin: ${ORBITAL_CATALOG_MAX_STALE_MINUTES},`));
  });
});
