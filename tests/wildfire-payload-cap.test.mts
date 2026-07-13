import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { compactWildfireBootstrapPayload } from '../api/bootstrap.js';
import {
  WILDFIRE_DASHBOARD_DETECTION_LIMIT,
  listFireDetections,
  limitFireDetectionsForDashboard,
} from '../server/worldmonitor/wildfire/v1/list-fire-detections.ts';
import { resolveFireDetectionTotalCount } from '../src/services/wildfires/payload.ts';
import type { FireDetection } from '../src/generated/server/worldmonitor/wildfire/v1/service_server';

const REGIONS = ['Ukraine', 'Russia', 'Iran', 'Israel/Gaza', 'Syria', 'Taiwan', 'North Korea', 'Saudi Arabia', 'Turkey'];
const SATELLITES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

function fireDetection(index: number, overrides: Partial<FireDetection> = {}): FireDetection {
  return {
    id: `${(45 + index / 1000).toFixed(3)}-${(30 + index / 1000).toFixed(3)}-2026-07-08-${String(index % 2400).padStart(4, '0')}`,
    location: { latitude: 45 + index / 1000, longitude: 30 + index / 1000 },
    brightness: 300 + (index % 140),
    frp: index % 200,
    confidence: index % 5 === 0 ? 'FIRE_CONFIDENCE_HIGH' : index % 3 === 0 ? 'FIRE_CONFIDENCE_NOMINAL' : 'FIRE_CONFIDENCE_LOW',
    satellite: SATELLITES[index % SATELLITES.length]!,
    detectedAt: 1783500000000 - index * 60_000,
    region: REGIONS[index % REGIONS.length]!,
    dayNight: index % 2 ? 'N' : 'D',
    possibleExplosion: index % 11 === 0,
    ...overrides,
  };
}

describe('wildfire dashboard payload cap', () => {
  it('serves the compact RPC payload without reading the canonical seed', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const requestedKeys: string[] = [];
    const compactPayload = {
      fireDetections: [fireDetection(1)],
      pagination: { nextCursor: '', totalCount: 1_234 },
      dataAvailable: true,
    };

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (input) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
      requestedKeys.push(key);
      const value = key === 'wildfire:fires-bootstrap:v1'
        ? compactPayload
        : key === 'seed-meta:wildfire:fires-bootstrap'
          ? { fetchedAt: 1_783_500_000_000 }
          : null;
      return Response.json({ result: value == null ? null : JSON.stringify(value) });
    };

    try {
      const response = await listFireDetections({} as never, {});

      assert.deepEqual(response, {
        ...compactPayload,
        fetchedAt: 1_783_500_000_000,
      });
      assert.deepEqual(requestedKeys, [
        'wildfire:fires-bootstrap:v1',
        'seed-meta:wildfire:fires-bootstrap',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  it('falls back to the canonical payload and metadata when the compact seed is missing', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const requestedKeys: string[] = [];
    const canonicalDetections = Array.from(
      { length: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 7 },
      (_, index) => fireDetection(index),
    );

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (input) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
      requestedKeys.push(key);
      const value = key === 'wildfire:fires:v1'
        ? { fireDetections: canonicalDetections, dataAvailable: true }
        : key === 'seed-meta:wildfire:fires'
          ? { fetchedAt: 1_783_600_000_000 }
          : null;
      return Response.json({ result: value == null ? null : JSON.stringify(value) });
    };

    try {
      const response = await listFireDetections({} as never, {});

      assert.equal(response.fireDetections.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
      assert.deepEqual(response.pagination, { nextCursor: '', totalCount: canonicalDetections.length });
      assert.equal(response.fetchedAt, 1_783_600_000_000);
      assert.equal(response.dataAvailable, true);
      assert.deepEqual(requestedKeys, [
        'wildfire:fires-bootstrap:v1',
        'seed-meta:wildfire:fires-bootstrap',
        'wildfire:fires:v1',
        'seed-meta:wildfire:fires',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  it('publishes and hydrates a dedicated pre-compacted bootstrap key', () => {
    const seeder = readFileSync(new URL('../scripts/seed-fire-detections.mjs', import.meta.url), 'utf8');
    const bootstrap = readFileSync(new URL('../api/bootstrap.js', import.meta.url), 'utf8');

    assert.match(seeder, /wildfire:fires-bootstrap:v1/);
    assert.match(seeder, /extraKeys\s*:/);
    assert.match(seeder, /metaKey:\s*'seed-meta:wildfire:fires-bootstrap'/);
    assert.match(bootstrap, /wildfires:\s*'wildfire:fires-bootstrap:v1'/);
    assert.doesNotMatch(bootstrap, /wildfires:\s*'wildfire:fires:v1'/);
  });

  it('packages the shared compactor with the seeder and keeps the Edge mirror in sync', () => {
    const seeder = readFileSync(new URL('../scripts/seed-fire-detections.mjs', import.meta.url), 'utf8');
    const scriptsHelper = readFileSync(new URL('../scripts/_wildfire-dashboard.mjs', import.meta.url), 'utf8');
    const edgeHelper = readFileSync(new URL('../api/_wildfire-dashboard.js', import.meta.url), 'utf8');

    assert.match(seeder, /from '\.\/_wildfire-dashboard\.mjs'/);
    assert.equal(edgeHelper, scriptsHelper, 'Edge helper mirror must match the scripts-packaged source');
  });

  it('caps response detections without mutating the seed array and keeps highest-signal detections', () => {
    const lowSignal = Array.from({ length: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 25 }, (_, index) =>
      fireDetection(index, {
        brightness: 300,
        frp: 1,
        confidence: 'FIRE_CONFIDENCE_LOW',
        possibleExplosion: false,
      }));
    const explosion = fireDetection(10_000, {
      id: 'explosion',
      brightness: 301,
      frp: 2,
      confidence: 'FIRE_CONFIDENCE_LOW',
      possibleExplosion: true,
    });
    const highConfidence = fireDetection(10_001, {
      id: 'high-confidence',
      brightness: 450,
      frp: 175,
      confidence: 'FIRE_CONFIDENCE_HIGH',
      possibleExplosion: false,
    });
    const source = [...lowSignal, highConfidence, explosion];

    const limited = limitFireDetectionsForDashboard(source);

    assert.equal(limited.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
    assert.equal(source.at(-1)?.id, 'explosion', 'source order should stay untouched');
    assert.equal(limited[0]?.id, 'explosion');
    assert.ok(limited.some((detection) => detection.id === 'high-confidence'));
  });

  it('caps bootstrap wildfire data and records the uncapped total count', () => {
    const fireDetections = Array.from({ length: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 1 }, (_, index) => fireDetection(index));
    const payload = { fireDetections, fetchedAt: 1783500000000, dataAvailable: true };

    const compacted = compactWildfireBootstrapPayload(payload);

    assert.equal(compacted.fireDetections.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
    assert.deepEqual(compacted.pagination, { nextCursor: '', totalCount: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 1 });
    assert.equal(payload.fireDetections.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT + 1);
  });

  it('keeps bootstrap and RPC caps in ranking parity', () => {
    const fireDetections = Array.from({ length: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 50 }, (_, index) => fireDetection(index));

    const bootstrapIds = compactWildfireBootstrapPayload({ fireDetections, fetchedAt: 1783500000000, dataAvailable: true })
      .fireDetections
      .map((detection: FireDetection) => detection.id);
    const rpcIds = limitFireDetectionsForDashboard(fireDetections).map((detection) => detection.id);

    assert.deepEqual(bootstrapIds, rpcIds);
  });

  it('coerces legacy missing possibleExplosion flags consistently', () => {
    const legacyHighBrightness = fireDetection(1, {
      id: 'legacy-high-brightness',
      brightness: 500,
      confidence: 'FIRE_CONFIDENCE_HIGH',
      possibleExplosion: false,
    }) as FireDetection & { possibleExplosion?: boolean };
    delete legacyHighBrightness.possibleExplosion;
    const explosion = fireDetection(2, {
      id: 'explosion',
      brightness: 300,
      confidence: 'FIRE_CONFIDENCE_LOW',
      possibleExplosion: true,
    });
    const fireDetections = [legacyHighBrightness as FireDetection, explosion];

    assert.deepEqual(
      compactWildfireBootstrapPayload({ fireDetections, fetchedAt: 1783500000000, dataAvailable: true }, 1).fireDetections.map((detection: FireDetection) => detection.id),
      ['explosion'],
    );
    assert.deepEqual(
      limitFireDetectionsForDashboard(fireDetections, 1).map((detection) => detection.id),
      ['explosion'],
    );
  });

  it('returns uncapped total count from capped responses', () => {
    const fireDetections = Array.from({ length: WILDFIRE_DASHBOARD_DETECTION_LIMIT }, (_, index) => fireDetection(index));

    assert.equal(
      resolveFireDetectionTotalCount({ fireDetections, pagination: { nextCursor: '', totalCount: WILDFIRE_DASHBOARD_DETECTION_LIMIT + 123 } }),
      WILDFIRE_DASHBOARD_DETECTION_LIMIT + 123,
    );
    assert.equal(
      resolveFireDetectionTotalCount({ fireDetections, pagination: { nextCursor: '', totalCount: WILDFIRE_DASHBOARD_DETECTION_LIMIT - 1 } }),
      WILDFIRE_DASHBOARD_DETECTION_LIMIT,
    );
  });

  it('keeps a high-volume FIRMS snapshot under the mobile first-load byte budget', () => {
    const fireDetections = Array.from({ length: 2500 }, (_, index) => fireDetection(index));
    const full = JSON.stringify({ fireDetections, fetchedAt: 1783500000000, dataAvailable: true });
    const compacted = JSON.stringify(compactWildfireBootstrapPayload({ fireDetections, fetchedAt: 1783500000000, dataAvailable: true }));

    assert.ok(Buffer.byteLength(full) > 600_000, 'fixture should represent the DebugBear payload-growth shape');
    assert.ok(Buffer.byteLength(compacted) < 160_000, `compacted payload is too large: ${Buffer.byteLength(compacted)} bytes`);
    assert.ok(gzipSync(compacted).byteLength < 20_000, `gzip payload is too large: ${gzipSync(compacted).byteLength} bytes`);
  });
});
