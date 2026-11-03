import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalNow = Date.now;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

type SnapshotResponse = {
  dataAvailable: boolean;
  fetchedAt: number;
  snapshot?: {
    sequence: number;
    status: { connected: boolean; vessels: number; messages: number };
    disruptions: never[];
    densityZones: never[];
    candidateReports: Array<{
      mmsi: string;
      name: string;
      lat: number;
      lon: number;
      shipType: number;
      heading: number;
      speed: number;
      course: number;
      timestamp: number;
    }>;
  };
};

type RuntimeGlobals = typeof globalThis & {
  __maritimeQueue?: Array<SnapshotResponse | Promise<SnapshotResponse>>;
  __maritimeRequests?: boolean[];
  __maritimePersistent?: Map<string, { data: unknown; updatedAt: number }>;
};

const runtime = globalThis as RuntimeGlobals;
let bundledSource = '';

function response(sequence: number, candidates = false): SnapshotResponse {
  return {
    dataAvailable: true,
    fetchedAt: Date.now(),
    snapshot: {
      sequence,
      status: { connected: true, vessels: candidates ? 1 : 0, messages: sequence },
      disruptions: [],
      densityZones: [],
      candidateReports: candidates
        ? [{
          mmsi: '123456789', name: 'Test Vessel', lat: 25, lon: 55,
          shipType: 35, heading: 90, speed: 12, course: 91, timestamp: sequence,
        }]
        : [],
    },
  };
}

function maritimeStubs() {
  return {
    name: 'maritime-cache-runtime-stubs',
    setup(builder: PluginBuild) {
      builder.onResolve({ filter: /^@\/utils$/ }, () => ({
        path: resolve(root, 'src/utils/circuit-breaker.ts'),
      }));
      for (const [filter, path] of [
        [/services\/generated-rpc-clients$/, 'stub:rpc'],
        [/services\/rpc-client$/, 'stub:rpc-base'],
        [/services\/persistent-cache$/, 'stub:persistent'],
        [/\.\.\/data-freshness$/, 'stub:freshness'],
        [/\.\.\/runtime-config$/, 'stub:runtime-config'],
        [/\.\.\/runtime$/, 'stub:runtime'],
      ] as const) {
        builder.onResolve({ filter }, () => ({ path, namespace: 'maritime-stub' }));
      }
      builder.onLoad({ filter: /.*/, namespace: 'maritime-stub' }, (args) => {
        if (args.path === 'stub:rpc') {
          return { loader: 'js', contents: `
            export class MaritimeServiceClient {
              async getVesselSnapshot(request) {
                globalThis.__maritimeRequests.push(request.includeCandidates);
                const value = globalThis.__maritimeQueue.shift();
                if (!value) throw new Error('Missing maritime fixture');
                return value;
              }
            }
          ` };
        }
        if (args.path === 'stub:rpc-base') {
          return { loader: 'js', contents: `export function getRpcBaseUrl() { return 'https://test.invalid'; }` };
        }
        if (args.path === 'stub:persistent') {
          return { loader: 'js', contents: `
            export async function getPersistentCache(key) { return globalThis.__maritimePersistent.get(key) ?? null; }
            export async function setPersistentCache(key, data) { globalThis.__maritimePersistent.set(key, { data, updatedAt: Date.now() }); }
            export async function deletePersistentCache(key) { globalThis.__maritimePersistent.delete(key); }
            export async function deletePersistentCacheByPrefix(prefix) {
              for (const key of globalThis.__maritimePersistent.keys()) if (key.startsWith(prefix)) globalThis.__maritimePersistent.delete(key);
            }
          ` };
        }
        if (args.path === 'stub:freshness') {
          return { loader: 'js', contents: `export const dataFreshness = { recordUpdate() {} };` };
        }
        if (args.path === 'stub:runtime-config') {
          return { loader: 'js', contents: `export function isFeatureAvailable() { return true; }` };
        }
        return { loader: 'js', contents: `export function startSmartPollLoop() { return { stop() {} }; }` };
      });
      builder.onLoad({ filter: /src\/services\/maritime\/index\.ts$/ }, (args) => ({
        loader: 'ts',
        contents: `${readFileSync(args.path, 'utf8')}\nexport { fetchSnapshotPayload, pollSnapshot, snapshotBreaker as testBreaker };`,
      }));
    },
  };
}

type Harness = {
  fetchSnapshotPayload(includeCandidates: boolean): Promise<{ sequence: number } | null>;
  pollSnapshot(force?: boolean): Promise<void>;
  registerAisCallback(callback: (data: { mmsi: string }) => void): Promise<void>;
  initAisStream(): void;
  getAisStatus(): { connected: boolean; vessels: number; messages: number };
  unregisterAisCallback(callback: (data: { mmsi: string }) => void): void;
  disconnectAisStream(): void;
};

before(async () => {
  const result = await build({
    stdin: {
      contents: `export { fetchSnapshotPayload, pollSnapshot, registerAisCallback, unregisterAisCallback, initAisStream, getAisStatus, getAisCandidateDataState, disconnectAisStream, testBreaker } from './src/services/maritime/index.ts';`,
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'maritime-cache-runtime-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"VITE_ENABLE_AIS":"true","DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [maritimeStubs()],
  });
  bundledSource = result.outputFiles[0]?.text ?? '';
  assert.ok(bundledSource);
});

afterEach(() => {
  Date.now = originalNow;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  delete runtime.__maritimeQueue;
  delete runtime.__maritimeRequests;
  delete runtime.__maritimePersistent;
});

function setup(queue: Array<SnapshotResponse | Promise<SnapshotResponse>>): void {
  runtime.__maritimeQueue = [...queue];
  runtime.__maritimeRequests = [];
  runtime.__maritimePersistent = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
}

async function loadHarness(): Promise<Harness> {
  return import(`data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}#${Math.random()}`) as Promise<Harness>;
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
}

test('maritime snapshots keep explicit cache policy contracts', () => {
  const source = readFileSync(new URL('../src/services/maritime/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function fetchSnapshotPayload');
  const end = source.indexOf('// ---- Callback Emission ----', start);
  const fn = source.slice(start, end);
  assert.match(fn, /cacheKey: includeCandidates \? 'candidates' : 'density'/);
  assert.match(fn, /shouldCache: \(result\) => result\.dataAvailable && result\.snapshot !== undefined/);
  assert.match(fn, /evictOnRefreshFailure: includeCandidates/);
});

test('a density sequence does not suppress the first candidate snapshot', async () => {
  setup([response(7), response(7, true)]);
  const harness = await loadHarness();
  await harness.pollSnapshot(true);

  const delivered: string[] = [];
  const callback = (data: { mmsi: string }) => delivered.push(data.mmsi);
  harness.registerAisCallback(callback);
  await settleBackgroundWork();

  assert.deepEqual(runtime.__maritimeRequests, [false, true]);
  assert.deepEqual(delivered, ['123456789']);
  harness.unregisterAisCallback(callback);
  harness.disconnectAisStream();
});

// #8634: the density layer starts polling before the military layer registers,
// and polling used to fetch candidates only at the next 5-minute tick.
test('the first callback fetches candidates immediately when polling already runs', async () => {
  setup([response(7), response(8, true)]);
  const harness = await loadHarness();
  harness.initAisStream();
  await settleBackgroundWork();
  assert.deepEqual(runtime.__maritimeRequests, [false]);

  const delivered: string[] = [];
  const callback = (data: { mmsi: string }) => delivered.push(data.mmsi);
  await harness.registerAisCallback(callback);

  assert.deepEqual(runtime.__maritimeRequests, [false, true]);
  assert.deepEqual(delivered, ['123456789'], 'registration resolves after the first candidates are delivered');

  const secondCallback = () => {};
  await harness.registerAisCallback(secondCallback);
  assert.deepEqual(runtime.__maritimeRequests, [false, true], 'later callbacks share the running candidate poll');
  harness.unregisterAisCallback(secondCallback);
  harness.unregisterAisCallback(callback);
  harness.disconnectAisStream();
});

test('a density poll that finishes after a newer candidate poll does not overwrite shared status', async () => {
  let releaseDensity!: (value: SnapshotResponse) => void;
  const pendingDensity = new Promise<SnapshotResponse>((resolveResponse) => { releaseDensity = resolveResponse; });
  setup([pendingDensity, response(9, true)]);
  const harness = await loadHarness();
  harness.initAisStream();
  await settleBackgroundWork();

  const callback = () => {};
  await harness.registerAisCallback(callback);
  assert.equal(harness.getAisStatus().messages, 9);

  releaseDensity(response(7));
  await settleBackgroundWork();

  assert.equal(harness.getAisStatus().messages, 9, 'the older density response must not replace newer status');
  harness.unregisterAisCallback(callback);
  harness.disconnectAisStream();
});

test('a candidate response does not advance the watermark after its callback is removed', async () => {
  let releaseResponse!: (value: SnapshotResponse) => void;
  const pendingResponse = new Promise<SnapshotResponse>((resolveResponse) => {
    releaseResponse = resolveResponse;
  });
  setup([pendingResponse]);
  const harness = await loadHarness();

  const firstDelivered: string[] = [];
  const firstCallback = (data: { mmsi: string }) => firstDelivered.push(data.mmsi);
  harness.registerAisCallback(firstCallback);
  await settleBackgroundWork();
  harness.unregisterAisCallback(firstCallback);
  releaseResponse(response(9, true));
  await settleBackgroundWork();

  const secondDelivered: string[] = [];
  const secondCallback = (data: { mmsi: string }) => secondDelivered.push(data.mmsi);
  harness.registerAisCallback(secondCallback);
  await harness.pollSnapshot(true);

  assert.deepEqual(firstDelivered, []);
  assert.deepEqual(secondDelivered, ['123456789']);
  assert.deepEqual(runtime.__maritimeRequests, [true]);
  harness.unregisterAisCallback(secondCallback);
  harness.disconnectAisStream();
});

test('a callback that unregisters during delivery resets the candidate watermark', async () => {
  setup([response(10, true)]);
  const harness = await loadHarness();

  const firstDelivered: string[] = [];
  const firstCallback = (data: { mmsi: string }) => {
    firstDelivered.push(data.mmsi);
    harness.unregisterAisCallback(firstCallback);
  };
  harness.registerAisCallback(firstCallback);
  await settleBackgroundWork();

  const secondDelivered: string[] = [];
  const secondCallback = (data: { mmsi: string }) => secondDelivered.push(data.mmsi);
  harness.registerAisCallback(secondCallback);
  await harness.pollSnapshot(true);

  assert.deepEqual(firstDelivered, ['123456789']);
  assert.deepEqual(secondDelivered, ['123456789']);
  assert.deepEqual(runtime.__maritimeRequests, [true]);
  harness.unregisterAisCallback(secondCallback);
  harness.disconnectAisStream();
});

test('a degraded candidate refresh cannot pin the stale candidate entry', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  setup([
    response(1, true),
    { dataAvailable: false, fetchedAt: 0, snapshot: undefined },
    response(2, true),
  ]);
  const harness = await loadHarness();

  assert.equal((await harness.fetchSnapshotPayload(true))?.sequence, 1);
  now += 11 * 60 * 1000;
  assert.equal((await harness.fetchSnapshotPayload(true))?.sequence, 1, 'stale data is returned while refresh runs');
  await settleBackgroundWork();

  assert.equal((await harness.fetchSnapshotPayload(true))?.sequence, 2, 'degraded refresh must evict the stale candidate entry');
  assert.deepEqual(runtime.__maritimeRequests, [true, true, true]);
});

function deferredSnapshot() {let resolve!: (v:SnapshotResponse)=>void,reject!: (e:Error)=>void;const promise=new Promise<SnapshotResponse>((ok,bad)=>{resolve=ok;reject=bad;});return {promise,resolve,reject};}
test('candidate confirmation is current only for accepted live empty and expires at existing freshness limit',async()=>{
 let now=1791296400000;Date.now=()=>now;setup([response(1)]);const h=await loadHarness() as any;const callback=()=>{};await h.registerAisCallback(callback);assert.equal(h.getAisCandidateDataState().mode,'live');now+=6*60*1000+1;assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.unregisterAisCallback(callback);h.disconnectAisStream();
});
test('dataAvailable false with a snapshot preserves callback admission but cannot confirm absence',async()=>{
 setup([{...response(1,true),dataAvailable:false}]);const h=await loadHarness() as any;const delivered:string[]=[];const callback=(p:any)=>delivered.push(p.mmsi);await h.registerAisCallback(callback);assert.deepEqual(delivered,['123456789']);assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.unregisterAisCallback(callback);h.disconnectAisStream();
});
test('density-only success cannot restore failed candidate evidence',async()=>{
 const fail=deferredSnapshot();setup([response(1),fail.promise,response(2)]);const h=await loadHarness() as any;await h.pollSnapshot(true);const callback=()=>{};const first=h.registerAisCallback(callback);await settleBackgroundWork();fail.reject(Error('fixture candidate failed'));await first;assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.unregisterAisCallback(callback);await h.pollSnapshot(true);assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.disconnectAisStream();
});
test('older candidate success after newer failure cannot certify zero while callbacks still deliver unchanged',async()=>{
 const old=deferredSnapshot(),recent=deferredSnapshot();setup([old.promise,recent.promise]);const h=await loadHarness() as any;const delivered:string[]=[];const callback=(p:any)=>delivered.push(p.mmsi);const first=h.registerAisCallback(callback);await settleBackgroundWork();const second=h.pollSnapshot(true);await settleBackgroundWork();recent.reject(Error('newer fixture failed'));await second;old.resolve(response(9,true));await first;assert.deepEqual(delivered,['123456789']);assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.unregisterAisCallback(callback);h.disconnectAisStream();
});
test('duplicate or older sequence cannot renew candidate confirmation; later accepted sequence recovers',async()=>{
 let now=1791296400000;Date.now=()=>now;setup([response(7),response(7),response(6),response(8)]);const h=await loadHarness() as any;const callback=()=>{};await h.registerAisCallback(callback);assert.equal(h.getAisCandidateDataState().mode,'live');for(const expected of ['unavailable','unavailable','live']){h.testBreaker.clearCache();await settleBackgroundWork();now+=1000;await h.pollSnapshot(true);assert.equal(h.getAisCandidateDataState().mode,expected);}h.unregisterAisCallback(callback);assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.disconnectAisStream();
});
test('cached candidate sample cannot be upgraded by a density live read or new callback lifecycle',async()=>{
 setup([response(7)]);const h=await loadHarness() as any;const callback=()=>{};await h.registerAisCallback(callback);assert.equal(h.getAisCandidateDataState().mode,'live');h.unregisterAisCallback(callback);await h.registerAisCallback(callback);assert.equal(h.getAisCandidateDataState().mode,'cached');assert.equal(h.getAisCandidateDataState().timestamp,null);h.disconnectAisStream();assert.equal(h.getAisCandidateDataState().mode,'unavailable');h.unregisterAisCallback(callback);
});

for (const sequence of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`unknown candidate sequence ${String(sequence)} cannot confirm absence or suppress callback delivery`, async () => {
    let now = 1791296400000;
    Date.now = () => now;
    const samples = [response(sequence as number, true), response(sequence as number, true), response(1, true)];
    samples.forEach((sample, index) => { sample.snapshot!.candidateReports[0]!.timestamp = now + index * 1000; });
    setup(samples);
    const h = await loadHarness() as any;
    const delivered: string[] = [];
    const callback = (p: { mmsi: string }) => delivered.push(p.mmsi);
    await h.registerAisCallback(callback);
    assert.deepEqual(h.getAisCandidateDataState(), { mode: 'unavailable', timestamp: null, offline: false });
    assert.deepEqual(delivered, ['123456789']);
    h.testBreaker.clearCache();
    await settleBackgroundWork();
    now += 1000;
    await h.pollSnapshot(true);
    assert.deepEqual(h.getAisCandidateDataState(), { mode: 'unavailable', timestamp: null, offline: false });
    const repeatedDeliveries = sequence === 0 ? 2 : 1;
    assert.equal(delivered.length, repeatedDeliveries, 'retain existing callback watermark policy');
    h.testBreaker.clearCache();
    await settleBackgroundWork();
    now += 1000;
    await h.pollSnapshot(true);
    if (sequence === 0 || sequence === null) {
      assert.deepEqual(h.getAisCandidateDataState(), { mode: 'live', timestamp: now, offline: false });
      assert.equal(delivered.length, repeatedDeliveries + 1);
    } else {
      assert.equal(h.getAisCandidateDataState().mode, 'unavailable', 'invalid callback watermark must not be reset by metadata');
      assert.equal(delivered.length, repeatedDeliveries);
    }
    h.unregisterAisCallback(callback);
    assert.equal(h.getAisCandidateDataState().mode, 'unavailable');
    h.disconnectAisStream();
    assert.equal(h.getAisCandidateDataState().mode, 'unavailable');
  });
}
