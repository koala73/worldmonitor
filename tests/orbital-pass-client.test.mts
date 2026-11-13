import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { findPasses, parseOrbitElements, type OmmRecord } from '../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import { decidePassTier } from '../shared/orbital/tiers.js';
import type { ListImagingSatellitesResponse, OmmElements } from '../src/generated/client/worldmonitor/orbital/v1/service_client.ts';
import { toOmmRecord, toOrbitalCatalog, type OrbitalCatalog } from '../src/services/orbital/catalog.ts';
import { createOrbitalPassClient, type PassWorkerLike } from '../src/services/orbital/pass-client.ts';
import { createPassJobHandler, runPassJob, type CatalogSatellite, type PassJobReply, type PassJobRequest } from '../src/services/orbital/pass-job.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const PARIS = { lat: 48.8566, lon: 2.3522 };
const NAIROBI = { lat: -1.2921, lon: 36.8219 };

const records: OmmRecord[] = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8')).records;

const satellites: CatalogSatellite[] = records.flatMap((record) => {
  const profile = matchSensorProfile(record.NORAD_CAT_ID as number, record.OBJECT_NAME);
  return profile ? [{ noradId: Number(record.NORAD_CAT_ID), name: record.OBJECT_NAME, profileId: profile.id, elementSets: [record] }] : [];
});

const catalog: OrbitalCatalog = { status: 'fresh', fetchedAt: NOW - HOUR, inventoryVersion: 'test', satellites };

const summary = (passes: Array<{ noradId: number; timeMs: number; tier: { kind: string } }>) =>
  passes.map((pass) => `${pass.noradId}@${pass.timeMs}:${pass.tier.kind}`).sort();

function expectedPasses(point: typeof PARIS, window: { startMs: number; endMs: number }) {
  return satellites.flatMap((satellite) => {
    const profile = matchSensorProfile(satellite.noradId, satellite.name)!;
    const search = findPasses({ elements: parseOrbitElements(satellite.elementSets[0]!), profile, point, window: { start: window.startMs, end: window.endMs }, now: NOW });
    return search.passes.map((pass) => ({ ...pass, tier: decidePassTier(pass, profile, null, NOW) }));
  });
}

class InProcessWorker implements PassWorkerLike {
  onmessage: PassWorkerLike['onmessage'] = null;
  onerror: PassWorkerLike['onerror'] = null;
  terminated = false;
  readonly computeRequests: PassJobRequest[] = [];
  private readonly held: PassJobReply[] = [];
  private readonly handle = createPassJobHandler((reply) => {
    if (this.holdResults && reply.type === 'result') this.held.push(reply);
    else this.deliver(reply);
  });

  constructor(options: { signalReady?: boolean } = {}, public holdResults = false) {
    if (options.signalReady !== false) setTimeout(() => this.deliver({ type: 'ready' }), 0);
  }

  postMessage(message: PassJobRequest): void {
    if (message.type === 'compute') this.computeRequests.push(message);
    setTimeout(() => this.handle(structuredClone(message)), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  releaseHeld(): void {
    for (const reply of this.held.splice(0)) this.deliver(reply);
  }

  private deliver(reply: PassJobReply): void {
    if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<PassJobReply>);
  }
}

const lookupQuery = (point = PARIS) => ({ point, pastDays: 1, futureHours: 24 });
const lookupWindow = { startMs: NOW - DAY, endMs: NOW + 24 * HOUR };

describe('orbital pass client', () => {
  it('resolves with the passes the pure geometry returns for the same input, computed in the worker', async () => {
    const client = createOrbitalPassClient({ createWorker: () => new InProcessWorker(), loadCatalog: async () => catalog, now: () => NOW });
    const progress: number[] = [];
    const lookup = await client.lookup(lookupQuery(), { onProgress: (done) => progress.push(done) });
    assert.equal(lookup.computedOn, 'worker');
    assert.deepEqual(lookup.window, lookupWindow);
    assert.deepEqual(summary(lookup.passes), summary(expectedPasses(PARIS, lookupWindow)));
    assert.ok(lookup.passes.length > 0, 'fixture satellites pass over Paris within two days');
    assert.equal(progress.at(-1), satellites.length, 'progress reaches every satellite');
    assert.deepEqual(lookup.catalog, { status: 'fresh', fetchedAt: NOW - HOUR, inventoryVersion: 'test' });
  });

  it('cancels the previous lookup when a new point is requested, so the first never resolves with stale results', async () => {
    const worker = new InProcessWorker({}, true);
    const client = createOrbitalPassClient({ createWorker: () => worker, loadCatalog: async () => catalog, now: () => NOW });
    const first = client.lookup(lookupQuery(PARIS));
    const firstOutcome = first.then(() => 'resolved', (error: Error) => error.name);
    while (worker.computeRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    worker.holdResults = false;
    const second = client.lookup(lookupQuery(NAIROBI));
    worker.releaseHeld();
    assert.equal(await firstOutcome, 'AbortError');
    const lookup = await second;
    assert.deepEqual(lookup.point, NAIROBI);
    assert.deepEqual(summary(lookup.passes), summary(expectedPasses(NAIROBI, lookupWindow)));
  });

  it('rejects with an AbortError when the caller aborts', async () => {
    const client = createOrbitalPassClient({ createWorker: () => new InProcessWorker(), loadCatalog: async () => catalog, now: () => NOW });
    const controller = new AbortController();
    const pending = client.lookup(lookupQuery(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });

  it('falls back to the main thread with the same passes when the worker cannot be constructed', async () => {
    let attempts = 0;
    const client = createOrbitalPassClient({
      createWorker: () => {
        attempts += 1;
        throw new Error('Workers are not supported');
      },
      loadCatalog: async () => catalog,
      now: () => NOW,
    });
    const lookup = await client.lookup(lookupQuery());
    assert.equal(lookup.computedOn, 'main-thread');
    assert.deepEqual(summary(lookup.passes), summary(expectedPasses(PARIS, lookupWindow)));
    await client.lookup(lookupQuery(NAIROBI));
    assert.equal(attempts, 1, 'an unavailable worker is not retried on every lookup');
  });

  it('rejects when the worker never signals ready, then retries with a fresh worker', async () => {
    const workers: InProcessWorker[] = [];
    const client = createOrbitalPassClient({
      createWorker: () => {
        const worker = new InProcessWorker({ signalReady: workers.length > 0 });
        workers.push(worker);
        return worker;
      },
      loadCatalog: async () => catalog,
      now: () => NOW,
      readyTimeoutMs: 20,
    });
    await assert.rejects(client.lookup(lookupQuery()), /did not become ready within 20 ms/);
    assert.equal(workers[0]!.terminated, true);
    const lookup = await client.lookup(lookupQuery());
    assert.equal(lookup.computedOn, 'worker');
    assert.equal(workers.length, 2);
  });

  it('terminates a worker that finishes starting after the client was disposed', async () => {
    const workers: InProcessWorker[] = [];
    const client = createOrbitalPassClient({
      createWorker: () => {
        const worker = new InProcessWorker();
        workers.push(worker);
        queueMicrotask(() => client.dispose());
        return worker;
      },
      loadCatalog: async () => catalog,
      now: () => NOW,
    });
    await assert.rejects(client.lookup(lookupQuery()), { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.terminated, true);
  });

  it('rejects with a RangeError for non-finite, reversed or longer than ten day windows and invalid points', async () => {
    const client = createOrbitalPassClient({ createWorker: () => new InProcessWorker(), loadCatalog: async () => catalog, now: () => NOW });
    await assert.rejects(client.lookup({ point: PARIS, pastDays: Number.NaN }), RangeError);
    await assert.rejects(client.lookup({ point: PARIS, pastDays: -3, futureHours: 0 }), RangeError);
    await assert.rejects(client.lookup({ point: PARIS, pastDays: 8, futureHours: 72 }), RangeError);
    await assert.rejects(client.lookup({ point: { lat: 91, lon: 0 } }), RangeError);
    await assert.rejects(client.lookup({ point: { lat: 0, lon: Number.POSITIVE_INFINITY } }), RangeError);
    await assert.rejects(runPassJob({ point: PARIS, window: { startMs: NOW, endMs: NOW + 11 * DAY }, nowMs: NOW, satellites }), RangeError);
  });

  it('returns no passes without starting a worker when the catalog is empty', async () => {
    let attempts = 0;
    const client = createOrbitalPassClient({
      createWorker: () => {
        attempts += 1;
        return new InProcessWorker();
      },
      loadCatalog: async () => ({ ...catalog, status: 'empty', satellites: [] }),
      now: () => NOW,
    });
    const lookup = await client.lookup(lookupQuery());
    assert.deepEqual([lookup.passes, lookup.catalog.status, lookup.computedOn, attempts], [[], 'empty', 'none', 0]);
  });
});

describe('orbital pass job', () => {
  it('computes each part of the window from the element set nearest in time', async () => {
    const [sentinel] = satellites;
    const current = sentinel!.elementSets[0]!;
    const olderEpoch = new Date(Date.parse(`${current.EPOCH}Z`) - 4 * DAY).toISOString().replace('Z', '');
    const older = { ...current, EPOCH: olderEpoch };
    const window = { startMs: NOW - 7 * DAY, endMs: NOW };
    const result = await runPassJob({ point: PARIS, window, nowMs: NOW, satellites: [{ ...sentinel!, elementSets: [older, current] }] });
    assert.ok(result);
    const currentEpochMs = parseOrbitElements(current).epochMs;
    const olderEpochMs = parseOrbitElements(older).epochMs;
    const boundary = (currentEpochMs + olderEpochMs) / 2;
    const early = result.passes.filter((pass) => pass.timeMs < boundary);
    const late = result.passes.filter((pass) => pass.timeMs >= boundary);
    assert.ok(early.length > 0 && late.length > 0, 'passes on both sides of the boundary');
    assert.ok(early.every((pass) => pass.elementsEpochMs === olderEpochMs));
    assert.ok(late.every((pass) => pass.elementsEpochMs === currentEpochMs));
    assert.ok(result.passes.every((pass) => Math.abs(pass.orbitAgeDays - Math.abs(pass.timeMs - pass.elementsEpochMs) / DAY) < 1e-9));
  });

  it('covers the whole window from usable element sets when a stored set is too old to trust', async () => {
    const [sentinel] = satellites;
    const current = sentinel!.elementSets[0]!;
    const stale = { ...current, EPOCH: new Date(Date.parse(`${current.EPOCH}Z`) - 7 * DAY).toISOString().replace('Z', '') };
    const window = { startMs: NOW - 7 * DAY, endMs: NOW };
    const withStale = await runPassJob({ point: PARIS, window, nowMs: NOW, satellites: [{ ...sentinel!, elementSets: [stale, current] }] });
    const currentOnly = await runPassJob({ point: PARIS, window, nowMs: NOW, satellites: [{ ...sentinel!, elementSets: [current] }] });
    assert.equal(withStale!.satellites[0]!.status, 'ok');
    assert.ok(withStale!.passes.some((pass) => pass.timeMs < NOW - 5 * DAY), 'passes early in the window are kept');
    assert.deepEqual(summary(withStale!.passes), summary(currentOnly!.passes));
  });

  it('reports a satellite with unusable elements without failing the lookup', async () => {
    const broken = { ...satellites[0]!, elementSets: [{ ...satellites[0]!.elementSets[0]!, MEAN_MOTION: 'not a number', EPOCH: 'garbage' }] };
    const result = await runPassJob({ point: PARIS, window: lookupWindow, nowMs: NOW, satellites: [broken, satellites[1]!] });
    assert.equal(result!.satellites[0]!.status, 'invalid-elements');
    assert.equal(result!.satellites[1]!.status, 'ok');
  });
});

const toCamel = (record: OmmRecord): OmmElements => ({
  objectName: String(record.OBJECT_NAME),
  objectId: String(record.OBJECT_ID),
  epoch: String(record.EPOCH),
  meanMotion: Number(record.MEAN_MOTION),
  eccentricity: Number(record.ECCENTRICITY),
  inclination: Number(record.INCLINATION),
  raOfAscNode: Number(record.RA_OF_ASC_NODE),
  argOfPericenter: Number(record.ARG_OF_PERICENTER),
  meanAnomaly: Number(record.MEAN_ANOMALY),
  ephemerisType: Number(record.EPHEMERIS_TYPE),
  classificationType: String(record.CLASSIFICATION_TYPE),
  noradCatId: Number(record.NORAD_CAT_ID),
  elementSetNo: Number(record.ELEMENT_SET_NO),
  revAtEpoch: Number(record.REV_AT_EPOCH),
  bstar: Number(record.BSTAR),
  meanMotionDot: Number(record.MEAN_MOTION_DOT),
  meanMotionDdot: Number(record.MEAN_MOTION_DDOT),
});

function catalogResponse(overrides: Partial<ListImagingSatellitesResponse> = {}): ListImagingSatellitesResponse {
  return {
    inventoryVersion: 'test',
    profiles: [],
    satellites: satellites.map((satellite) => ({ noradId: satellite.noradId, name: satellite.name, profileId: satellite.profileId, elements: toCamel(satellite.elementSets[0]!) })),
    ring: [],
    fetchedAt: NOW,
    source: 'test',
    stale: false,
    ...overrides,
  };
}

describe('orbital catalog', () => {
  it('converts the catalog response into element sets the pass geometry accepts', () => {
    const record = satellites[0]!.elementSets[0]!;
    const converted = toOmmRecord(toCamel(record));
    const profile = matchSensorProfile(satellites[0]!.noradId, satellites[0]!.name)!;
    const passTimes = (omm: OmmRecord) =>
      findPasses({ elements: parseOrbitElements(omm), profile, point: PARIS, window: { start: lookupWindow.startMs, end: lookupWindow.endMs }, now: NOW }).passes.map((pass) => pass.timeMs);
    assert.deepEqual(passTimes(converted), passTimes(record));
    assert.equal(toOrbitalCatalog(catalogResponse()).satellites.length, satellites.length);
  });

  it('merges stored daily element sets by epoch, oldest first, and drops satellites without a known profile', () => {
    const first = toCamel(satellites[0]!.elementSets[0]!);
    const olderDay = { ...first, epoch: '2026-11-09T10:00:00.000000' };
    const response = catalogResponse({
      satellites: [
        ...catalogResponse().satellites,
        { noradId: 1, name: 'UNKNOWN', profileId: 'not-a-profile', elements: first },
      ],
      ring: [
        { day: '2026-11-11', fetchedAt: NOW - 2 * DAY, elements: [first] },
        { day: '2026-11-09', fetchedAt: NOW - 4 * DAY, elements: [olderDay] },
      ],
    });
    const parsed = toOrbitalCatalog(response);
    assert.equal(parsed.satellites.length, satellites.length);
    assert.deepEqual(parsed.satellites[0]!.elementSets.map((set) => set.EPOCH), [olderDay.epoch, first.epoch]);
  });

  it('reports a stale catalog as stale and a catalog without usable satellites as empty', () => {
    assert.equal(toOrbitalCatalog(catalogResponse()).status, 'fresh');
    assert.equal(toOrbitalCatalog(catalogResponse({ stale: true })).status, 'stale');
    assert.equal(toOrbitalCatalog(catalogResponse({ satellites: [], stale: true })).status, 'empty');
  });
});
