import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { compactWildfireBootstrapPayload } from '../api/bootstrap.js';
import { resolveBootstrapRegistry } from '../api/_bootstrap-tier-keys.js';
import {
  WILDFIRE_DASHBOARD_DETECTION_LIMIT,
  listFireDetections,
  limitFireDetectionsForDashboard,
} from '../server/worldmonitor/wildfire/v1/list-fire-detections.ts';
import { resolveFireDetectionTotalCount } from '../src/services/wildfires/payload.ts';
import {
  WILDFIRE_CANONICAL_DETECTION_LIMIT,
  compactWildfireDashboardPayload,
} from '../scripts/_wildfire-dashboard.mjs';
import { MAX_PAYLOAD_BYTES, runSeed } from '../scripts/_seed-utils.mjs';
import { buildEnvelope, unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';
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
    const { cacheKeys } = resolveBootstrapRegistry({ iranEventsEnabled: false });

    assert.match(seeder, /wildfire:fires-bootstrap:v1/);
    assert.match(seeder, /extraKeys\s*:/);
    assert.match(seeder, /metaKey:\s*'seed-meta:wildfire:fires-bootstrap'/);
    assert.equal(cacheKeys.wildfires, 'wildfire:fires-bootstrap:v1');
    assert.notEqual(cacheKeys.wildfires, 'wildfire:fires:v1');
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

// The volume of the run that crashed seed-fire-detections (Railway deployment 8008ae7a,
// 2026-07-30): 20,442 deduped VIIRS detections across 3 sources x 9 regions, every upstream
// fetch OK. atomicPublish threw `Payload too large: 5.2MB > 5MB limit`, main().catch printed
// FATAL and exited 1 — so nothing published and the 2h TTL was never extended.
const FIRMS_PEAK_DETECTIONS = 20_442;

// The canonical envelope must stay at or under 90% of the hard atomicPublish cap. This is the
// headroom guard #5866 asks for: raising WILDFIRE_CANONICAL_DETECTION_LIMIT or widening
// FireDetection turns the worst-case test below red in CI instead of crashing the seeder in
// production.
const CANONICAL_PAYLOAD_BYTE_BUDGET = Math.floor(MAX_PAYLOAD_BYTES * 0.9);

const FIRMS_SATELLITES = ['N', 'N20', 'N21'];
const FIRMS_CONFIDENCE = ['FIRE_CONFIDENCE_HIGH', 'FIRE_CONFIDENCE_NOMINAL', 'FIRE_CONFIDENCE_LOW'];

/**
 * A detection with production byte-width: FIRMS area/csv gives 5dp lat/lon and 2dp
 * bright_ti4/frp, and seed-fire-detections derives `id` from those raw cells. Sized against
 * the real incident — 20,442 of these serialize to ~5.2MB, matching the crash log.
 */
function firmsDetection(index: number): FireDetection {
  const latitude = Math.round((48.90554 + (index % 1000) / 1e5) * 1e5) / 1e5;
  const longitude = Math.round((37.55219 + (index % 997) / 1e5) * 1e5) / 1e5;
  const brightness = Math.round((295.05 + (index % 12_000) / 100) * 100) / 100;
  const frp = Math.round((1.06 + (index % 9000) / 100) * 100) / 100;
  return {
    id: `${latitude}-${longitude}-2026-07-30-${String(index % 2400).padStart(4, '0')}`,
    location: { latitude, longitude },
    brightness,
    frp,
    confidence: FIRMS_CONFIDENCE[index % FIRMS_CONFIDENCE.length]!,
    satellite: FIRMS_SATELLITES[index % FIRMS_SATELLITES.length]!,
    detectedAt: 1_785_416_460_000 + index * 1000,
    region: REGIONS[index % REGIONS.length]!,
    dayNight: index % 2 ? 'N' : 'D',
    possibleExplosion: frp > 80 && brightness > 380,
  };
}

/**
 * The widest detection MONITORED_REGIONS can actually produce: Russia's bbox reaches 180E/82N
 * (longest coordinate strings), 'Saudi Arabia' is the longest region name, and a FIRMS
 * confidence code outside h/n/l maps to the longest enum member.
 */
function widestFirmsDetection(index: number): FireDetection {
  const latitude = Math.round((81.99999 - (index % 1000) / 1e5) * 1e5) / 1e5;
  const longitude = Math.round((179.99999 - (index % 997) / 1e5) * 1e5) / 1e5;
  return {
    id: `${latitude}-${longitude}-2026-07-30-${String(index % 2400).padStart(4, '0')}`,
    location: { latitude, longitude },
    brightness: 367.05,
    frp: 1234.56,
    confidence: 'FIRE_CONFIDENCE_UNSPECIFIED',
    satellite: 'N21',
    detectedAt: 1_785_416_460_000 + index * 1000,
    region: 'Saudi Arabia',
    dayNight: 'N',
    possibleExplosion: true,
  };
}

/** Serialized size of exactly what atomicPublish measures for wildfire:fires:v1. */
function canonicalEnvelopeBytes(data: { fireDetections: FireDetection[] }): number {
  return Buffer.byteLength(JSON.stringify(buildEnvelope({
    fetchedAt: 1_785_416_460_000,
    recordCount: data.fireDetections.length,
    sourceVersion: 'VIIRS_SNPP_NRT+VIIRS_NOAA20_NRT+VIIRS_NOAA21_NRT',
    schemaVersion: 1,
    state: 'OK',
    data,
  })), 'utf8');
}

describe('canonical wildfire payload cap (#5866)', () => {
  // One allocation shared by the tests below — 20k detections is ~8MB resident and test:data
  // runs the whole tests/ tree in a single process.
  const peakDetections = Array.from({ length: FIRMS_PEAK_DETECTIONS }, (_, index) => firmsDetection(index));

  it('reproduces the crash: an uncapped peak-volume payload exceeds the atomicPublish cap', () => {
    const uncapped = canonicalEnvelopeBytes({ fireDetections: peakDetections });

    assert.ok(
      uncapped > MAX_PAYLOAD_BYTES,
      `fixture must reproduce the 5.2MB > 5MB crash, got ${(uncapped / 1024 / 1024).toFixed(2)}MB`,
    );
  });

  it('caps the published payload under the atomicPublish limit and keeps the true total', () => {
    const capped = compactWildfireDashboardPayload(
      { fireDetections: peakDetections, pagination: undefined },
      WILDFIRE_CANONICAL_DETECTION_LIMIT,
    );
    const bytes = canonicalEnvelopeBytes(capped);

    assert.equal(capped.fireDetections.length, WILDFIRE_CANONICAL_DETECTION_LIMIT);
    assert.deepEqual(capped.pagination, { nextCursor: '', totalCount: FIRMS_PEAK_DETECTIONS });
    assert.ok(
      bytes <= CANONICAL_PAYLOAD_BYTE_BUDGET,
      `capped payload ${(bytes / 1024 / 1024).toFixed(2)}MB exceeds the ${(CANONICAL_PAYLOAD_BYTE_BUDGET / 1024 / 1024).toFixed(2)}MB budget`,
    );
  });

  it('holds the byte budget at the cap even for the widest detections FIRMS can emit', () => {
    const widest = Array.from({ length: WILDFIRE_CANONICAL_DETECTION_LIMIT }, (_, index) => widestFirmsDetection(index));
    const bytes = canonicalEnvelopeBytes({ fireDetections: widest });

    assert.ok(
      bytes <= CANONICAL_PAYLOAD_BYTE_BUDGET,
      `a full cap of widest-case detections serializes to ${(bytes / 1024 / 1024).toFixed(2)}MB, over the ${(CANONICAL_PAYLOAD_BYTE_BUDGET / 1024 / 1024).toFixed(2)}MB budget — lower WILDFIRE_CANONICAL_DETECTION_LIMIT or shrink FireDetection`,
    );
    assert.ok(CANONICAL_PAYLOAD_BYTE_BUDGET < MAX_PAYLOAD_BYTES, 'budget must leave headroom under the hard cap');
  });

  it('leaves the bootstrap top-500 identical to the uncapped selection', () => {
    const capped = compactWildfireDashboardPayload(
      { fireDetections: peakDetections, pagination: undefined },
      WILDFIRE_CANONICAL_DETECTION_LIMIT,
    );

    // runSeed feeds extraKey transforms the RAW fetcher output, so the bootstrap key still
    // ranks over all 20,442. Capping the canonical by the same comparator must not be able to
    // change what the dashboard shows even if that ever stops being true.
    assert.deepEqual(
      limitFireDetectionsForDashboard(capped.fireDetections).map((detection) => detection.id),
      limitFireDetectionsForDashboard(peakDetections).map((detection) => detection.id),
    );
  });

  it('passes the pre-cap total through the RPC canonical fallback', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const canonical = compactWildfireDashboardPayload(
      { fireDetections: peakDetections, pagination: undefined },
      WILDFIRE_CANONICAL_DETECTION_LIMIT,
    );

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (input) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
      const value = key === 'wildfire:fires:v1'
        ? { ...canonical, dataAvailable: true }
        : key === 'seed-meta:wildfire:fires'
          ? { fetchedAt: 1_785_416_460_000 }
          : null;
      return Response.json({ result: value == null ? null : JSON.stringify(value) });
    };

    try {
      const response = await listFireDetections({} as never, {});

      assert.equal(response.fireDetections.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
      // Not WILDFIRE_CANONICAL_DETECTION_LIMIT — the seeder already dropped detections, so the
      // count the RPC reports must be the FIRMS total, not what survived the cap.
      assert.deepEqual(response.pagination, { nextCursor: '', totalCount: FIRMS_PEAK_DETECTIONS });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  it('wires the canonical cap into the seeder publish path', () => {
    const seeder = readFileSync(new URL('../scripts/seed-fire-detections.mjs', import.meta.url), 'utf8');

    // publishTransform (not fetchAllRegions) is the required seam: runSeed feeds extraKey
    // transforms the RAW fetcher output, so capping there keeps the bootstrap top-500 intact.
    assert.match(seeder, /publishTransform\s*:/);
    assert.match(seeder, /WILDFIRE_CANONICAL_DETECTION_LIMIT/);
  });

  it('executes the runSeed publish seam with capped canonical and raw bootstrap inputs', async () => {
    const originalFetch = globalThis.fetch;
    const originalExit = process.exit;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const calls: Array<{ url: string; body: unknown }> = [];
    const values = new Map<string, string>();
    const canonicalKey = 'test:wildfire:fires:v1';
    const bootstrapKey = 'test:wildfire:fires-bootstrap:v1';

    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body == null ? null : JSON.parse(String(init.body));
      calls.push({ url, body });

      if (url.endsWith('/pipeline')) {
        return Response.json(Array.isArray(body) ? body.map(() => ({ result: 1 })) : []);
      }
      if (url.includes('/get/')) {
        const key = decodeURIComponent(url.slice(url.indexOf('/get/') + 5));
        return Response.json({ result: values.get(key) ?? null });
      }
      if (Array.isArray(body)) {
        if (body[0] === 'SET' && typeof body[1] === 'string') values.set(body[1], body[2]);
        if (body[0] === 'DEL' && typeof body[1] === 'string') values.delete(body[1]);
      }
      return Response.json({ result: 'OK' });
    };
    process.exit = ((code = 0) => {
      const error = new Error(`__test_exit__:${code}`) as Error & { exitCode: number };
      error.exitCode = code;
      throw error;
    }) as typeof process.exit;

    try {
      let exitCode: number | null = null;
      try {
        await runSeed(
          'test',
          'wildfire-publish-seam',
          canonicalKey,
          async () => ({ fireDetections: peakDetections, pagination: undefined, dataAvailable: true }),
          {
            validateFn: (data) => Array.isArray(data?.fireDetections) && data.fireDetections.length > 0,
            ttlSeconds: 3600,
            publishTransform: (data) => compactWildfireDashboardPayload(data, WILDFIRE_CANONICAL_DETECTION_LIMIT),
            extraKeys: [{ key: bootstrapKey, transform: compactWildfireDashboardPayload }],
            declareRecords: (data) => data.fireDetections.length,
            sourceVersion: 'wildfire-test',
            schemaVersion: 1,
            maxStaleMin: 1440,
          },
        );
      } catch (error) {
        if (String((error as Error).message).startsWith('__test_exit__:')) {
          exitCode = (error as Error & { exitCode: number }).exitCode;
        } else {
          throw error;
        }
      }

      assert.equal(exitCode, 0, 'runSeed should publish successfully');

      const lastSet = (key: string) => {
        const matching = calls.filter((call) => {
          const body = call.body;
          return Array.isArray(body) && body[0] === 'SET' && body[1] === key;
        });
        assert.ok(matching.length > 0, `expected a SET for ${key}`);
        return JSON.parse(String((matching.at(-1)!.body as unknown[])[2]));
      };
      const canonicalEnvelope = lastSet(canonicalKey);
      const bootstrapEnvelope = lastSet(bootstrapKey);
      const canonical = unwrapEnvelope(canonicalEnvelope).data;
      const bootstrap = unwrapEnvelope(bootstrapEnvelope).data;

      assert.equal(canonical.fireDetections.length, WILDFIRE_CANONICAL_DETECTION_LIMIT);
      assert.deepEqual(canonical.pagination, { nextCursor: '', totalCount: FIRMS_PEAK_DETECTIONS });
      assert.equal(bootstrap.fireDetections.length, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
      assert.deepEqual(bootstrap.pagination, { nextCursor: '', totalCount: FIRMS_PEAK_DETECTIONS });
      assert.equal(canonicalEnvelope._seed.recordCount, WILDFIRE_CANONICAL_DETECTION_LIMIT);
      assert.equal(bootstrapEnvelope._seed.recordCount, WILDFIRE_DASHBOARD_DETECTION_LIMIT);
      assert.ok(
        Buffer.byteLength(JSON.stringify(canonicalEnvelope), 'utf8') <= CANONICAL_PAYLOAD_BYTE_BUDGET,
        'the real canonical publish must stay under the byte budget',
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.exit = originalExit;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });
});
