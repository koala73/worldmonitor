import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseOrbitElements, type OmmRecord } from '../shared/orbital/pass-geometry.js';
import { createOrbitalPassClient, type PassWorkerLike } from '../src/services/orbital/pass-client.ts';
import { createPassJobHandler, type CatalogSatellite, type PassJobReply, type PassJobRequest } from '../src/services/orbital/pass-job.ts';
import { computeReservoirNextPasses, computeReservoirNextPassesChunked, ICESAT2_PROFILE_ID } from '../src/services/orbital/reservoir-next-pass.ts';
import { STRATEGIC_RESERVOIR_SITES } from '../src/services/climate/reservoir-context.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-14.json', import.meta.url), 'utf8'));
const icesat: OmmRecord = fixture.records.find((r: OmmRecord) => r.OBJECT_NAME === 'ICESAT-2');
const nowMs = parseOrbitElements(icesat).epochMs;
const satellites: CatalogSatellite[] = [{ noradId: 43613, name: 'ICESAT-2', profileId: ICESAT2_PROFILE_ID, elementSets: [icesat] }];
const sites = [...STRATEGIC_RESERVOIR_SITES];
const input = { satellites, sites, nowMs };
const expected = () => computeReservoirNextPasses({ satellites }, sites, nowMs)!;

class InProcessWorker implements PassWorkerLike {
  onmessage: PassWorkerLike['onmessage'] = null;
  onerror: PassWorkerLike['onerror'] = null;
  readonly requests: PassJobRequest[] = [];
  private readonly handle = createPassJobHandler((reply) => this.onmessage?.({ data: structuredClone(reply) } as MessageEvent<PassJobReply>));
  constructor() { setTimeout(() => this.onmessage?.({ data: { type: 'ready' } } as MessageEvent<PassJobReply>), 0); }
  postMessage(message: PassJobRequest): void {
    this.requests.push(message);
    setTimeout(() => this.handle(structuredClone(message)), 0);
  }
  terminate(): void {}
}

const catalog = { status: 'fresh' as const, fetchedAt: nowMs, inventoryVersion: 't', satellites };
const clientWith = (worker: InProcessWorker | null) => createOrbitalPassClient({ createWorker: () => { if (!worker) throw new Error('no worker'); return worker; }, loadCatalog: async () => catalog, now: () => nowMs });

describe('reservoir next-pass scan off the main thread', () => {
  it('the pass worker handler answers with the same predictions as the synchronous scan', async () => {
    const replies: PassJobReply[] = [];
    const done = new Promise<void>((resolve) => {
      const handle = createPassJobHandler((reply) => { replies.push(reply); resolve(); });
      handle({ type: 'reservoir-next-passes', id: 7, input });
    });
    await done;
    const reply = replies[0]!;
    assert.equal(reply.type, 'reservoir-next-passes-result');
    assert.equal(reply.type === 'reservoir-next-passes-result' && reply.id, 7);
    const entries = reply.type === 'reservoir-next-passes-result' ? reply.passes : null;
    assert.deepEqual(entries, [...expected()]);
  });

  it('the client runs the scan in the worker and resolves the same Map', async () => {
    const worker = new InProcessWorker();
    const client = clientWith(worker);
    const passes = await client.reservoirNextPasses(input);
    assert.deepEqual([...passes!], [...expected()]);
    assert.equal(worker.requests.filter((r) => r.type === 'reservoir-next-passes').length, 1);
    client.dispose();
  });

  it('does not cancel an in-flight pass lookup, and a pass lookup does not cancel it', async () => {
    const worker = new InProcessWorker();
    const client = clientWith(worker);
    const scan = client.reservoirNextPasses(input);
    const lookup = client.lookup({ point: { lat: 48.85, lon: 2.35 }, pastDays: 1, futureHours: 24 });
    const [passes, found] = await Promise.all([scan, lookup]);
    assert.ok(passes instanceof Map);
    assert.equal(found.computedOn, 'worker');
    client.dispose();
  });

  it('falls back to a yielding main-thread scan, with the same Map, when no worker can start', async () => {
    const client = clientWith(null);
    const passes = await client.reservoirNextPasses(input);
    assert.deepEqual([...passes!], [...expected()]);
    client.dispose();
  });

  it('rejects with an AbortError and tells the worker to cancel when the signal aborts', async () => {
    const worker = new InProcessWorker();
    const client = clientWith(worker);
    const controller = new AbortController();
    const scan = client.reservoirNextPasses(input, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(scan, { name: 'AbortError' });
    assert.ok(worker.requests.some((r) => r.type === 'cancel'));
    client.dispose();
  });

  it('rejects at once for an already aborted signal', async () => {
    const client = clientWith(new InProcessWorker());
    await assert.rejects(client.reservoirNextPasses(input, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    client.dispose();
  });

  it('the chunked scan hands the event loop back repeatedly instead of holding it for the whole window', async () => {
    let ticks = 0;
    let running = true;
    const tick = () => { if (running) { ticks++; setImmediate(tick); } };
    setImmediate(tick);
    const passes = await computeReservoirNextPassesChunked({ satellites }, sites, {}, nowMs);
    running = false;
    assert.deepEqual([...passes!], [...expected()]);
    assert.ok(ticks >= 6, `the loop turned ${ticks} times during a 7-day scan`);
  });

  it('the chunked scan stops when cancelled', async () => {
    let calls = 0;
    const passes = await computeReservoirNextPassesChunked({ satellites }, sites, { isCancelled: () => ++calls > 2 }, nowMs);
    assert.equal(passes, null);
  });
});
