import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';

// #8634: the first military vessel snapshot was taken the instant the AIS
// callback registered, before any candidate report arrived, so the layer showed
// only USNI roster ships until the 15-minute intelligence refresh.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type AisPosition = { mmsi: string; name: string; lat: number; lon: number; shipType?: number };
type RuntimeGlobals = typeof globalThis & {
  __aisRegister?: (callback: (data: AisPosition) => void) => Promise<void>;
  __usniVessels?: Array<Record<string, unknown>>;
};

const runtime = globalThis as RuntimeGlobals;
let bundledSource = '';

function stubs() {
  return {
    name: 'military-vessels-stubs',
    setup(builder: PluginBuild) {
      builder.onResolve({ filter: /^@\/utils$/ }, () => ({ path: resolve(root, 'src/utils/circuit-breaker.ts') }));
      builder.onResolve({ filter: /^\.\/maritime$/ }, () => ({ path: 'stub:maritime', namespace: 'mv-stub' }));
      builder.onResolve({ filter: /^\.\/usni-fleet$/ }, () => ({ path: 'stub:usni', namespace: 'mv-stub' }));
      builder.onResolve({ filter: /services\/persistent-cache$/ }, () => ({ path: 'stub:persistent', namespace: 'mv-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'mv-stub' }, (args) => {
        if (args.path === 'stub:maritime') {
          return { loader: 'js', contents: `
            export function registerAisCallback(callback) { return globalThis.__aisRegister(callback); }
            export function unregisterAisCallback() {}
            export function isAisConfigured() { return true; }
            export function initAisStream() {}
          ` };
        }
        if (args.path === 'stub:usni') {
          return { loader: 'js', contents: `
            export async function fetchUSNIFleetReport() {
              const vessels = globalThis.__usniVessels;
              return vessels ? { vessels } : null;
            }
            export function mergeUSNIWithAIS(vessels, report, clusters) {
              return { vessels: [...vessels, ...report.vessels], clusters };
            }
          ` };
        }
        return { loader: 'js', contents: `
          export async function getPersistentCache() { return null; }
          export async function setPersistentCache() {}
          export async function deletePersistentCache() {}
          export async function deletePersistentCacheByPrefix() {}
        ` };
      });
    },
  };
}

type Harness = {
  fetchMilitaryVessels(): Promise<{ vessels: Array<{ id: string; mmsi: string }> }>;
  disconnectMilitaryVesselStream(): void;
};

before(async () => {
  const result = await build({
    stdin: {
      contents: `export { fetchMilitaryVessels, disconnectMilitaryVesselStream } from './src/services/military-vessels.ts';`,
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'military-vessels-first-snapshot-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    alias: { '@': resolve(root, 'src') },
    plugins: [stubs()],
  });
  bundledSource = result.outputFiles[0]?.text ?? '';
  assert.ok(bundledSource);
});

afterEach(() => {
  delete runtime.__aisRegister;
  delete runtime.__usniVessels;
});

async function loadHarness(): Promise<Harness> {
  return import(`data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}#${Math.random()}`) as Promise<Harness>;
}

const lawEnforcementVessel: AisPosition = { mmsi: '366999001', name: 'CGC TEST', lat: 25, lon: -80, shipType: 55 };

test('the first snapshot includes AIS contacts delivered by the first candidate poll', async () => {
  runtime.__aisRegister = async (callback) => {
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    callback(lawEnforcementVessel);
  };
  const harness = await loadHarness();

  const { vessels } = await harness.fetchMilitaryVessels();

  assert.deepEqual(vessels.map((v) => v.mmsi), ['366999001']);
  harness.disconnectMilitaryVesselStream();
});

test('a candidate poll that never settles does not hold the snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  runtime.__aisRegister = () => new Promise<void>(() => {});
  const harness = await loadHarness();

  let settled = false;
  const pending = harness.fetchMilitaryVessels().then((snapshot) => { settled = true; return snapshot; });
  const flush = () => new Promise<void>((resolveTick) => setImmediate(resolveTick));
  await flush();
  t.mock.timers.tick(7_999);
  await flush();
  assert.equal(settled, false, 'the snapshot waits for candidates until the cap');
  t.mock.timers.tick(1);
  const { vessels } = await pending;

  assert.deepEqual(vessels, []);
  harness.disconnectMilitaryVesselStream();
});

test('a rejected candidate poll does not break later snapshots', async () => {
  let deliver!: (data: AisPosition) => void;
  runtime.__aisRegister = (callback) => {
    deliver = callback;
    return Promise.reject(new Error('relay down'));
  };
  const harness = await loadHarness();

  assert.deepEqual((await harness.fetchMilitaryVessels()).vessels, []);
  deliver(lawEnforcementVessel);
  const { vessels } = await harness.fetchMilitaryVessels();

  assert.deepEqual(vessels.map((v) => v.mmsi), ['366999001']);
  harness.disconnectMilitaryVesselStream();
});

test('the vessel cap keeps hull-numbered roster ships ahead of generic AIS contacts', async () => {
  runtime.__usniVessels = [{
    id: 'usni-DDG-51', mmsi: '', name: 'USS Arleigh Burke', vesselType: 'destroyer', hullNumber: 'DDG-51',
    operator: 'usn', operatorCountry: 'USA', lat: 36.9, lon: -76.3, heading: 0, speed: 0,
    lastAisUpdate: new Date('2026-09-21T00:00:00Z'), confidence: 'low', isInteresting: false, usniSource: true,
  }];
  // A full cap of fresher, unidentified special craft (tugs, pilots, SAR).
  runtime.__aisRegister = async (callback) => {
    for (let i = 0; i < 500; i++) {
      callback({ mmsi: String(366000000 + i), name: `TUG ${i}`, lat: 10 + i / 100, lon: 10, shipType: 52 });
    }
  };
  const harness = await loadHarness();

  const { vessels } = await harness.fetchMilitaryVessels();

  assert.equal(vessels.length, 500);
  assert.ok(vessels.some((v) => v.id === 'usni-DDG-51'), 'the roster destroyer must survive the cap');
  harness.disconnectMilitaryVesselStream();
});
