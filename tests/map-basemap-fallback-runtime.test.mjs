import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.createSourceFile('DeckGLMap.ts', readFileSync(
  new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DeckGLMap');
const methods = ['initMapLibre', 'getCenter', 'destroy'];
const body = declaration.members.filter(node => methods.includes(node.name?.getText(source)))
  .map(node => node.getText(source)).join('\n');
const javascript = ts.transpileModule(`class Harness { ${body} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function createHarness({ failReplacement = true, scheduleMicrotask = queueMicrotask } = {}) {
  let timeout;
  let constructions = 0;
  let removals = 0;
  const cameras = [];
  const warnings = [];
  const canvasEvents = {};
  const dependencies = {
    maplibregl: { setWorkerUrl() {} },
    maplibreWorkerUrl: '',
    VIEW_PRESETS: { global: { latitude: 0, longitude: 0, zoom: 2 } },
    isHappyVariant: false,
    document: { getElementById: () => ({}) },
    MAP_INTERACTION_MODE: 'flat',
    isLightMapTheme: () => false,
    FALLBACK_DARK_STYLE: 'fallback',
    FALLBACK_LIGHT_STYLE: 'fallback',
    setTrustedHtml() {},
    trustedHtml: value => value,
    window: { removeEventListener() {} },
    setTimeout: callback => { timeout = callback; return 1; },
    clearTimeout() {},
    queueMicrotask: scheduleMicrotask,
    console: { warn: (...args) => warnings.push(args) },
    DeckCompatibleMap: class {
      constructor(options) {
        constructions++;
        if (constructions > 1 && failReplacement) throw new Error('WebGL2 is required');
        cameras.push({ center: options.center, zoom: options.zoom });
      }
      on() {}
      getCanvas() { return { addEventListener: (event, callback) => { canvasEvents[event] = callback; } }; }
      getCenter() { return { lat: 48, lng: 12 }; }
      getZoom() { return 5; }
      remove() { removals++; }
    },
  };
  const Harness = new Function(...Object.keys(dependencies), `${javascript}; return Harness;`)(...Object.values(dependencies));
  const map = new Harness();
  Object.assign(map, {
    container: { querySelector: () => null },
    state: { view: 'global', zoom: 5 },
    pendingCenter: null,
    resolveInitialBasemapStyle: async () => ({ mapTheme: 'dark', style: {} }),
    attachMapLibreInteractionHandlers() {},
    detachMapLibreInteractionHandlers() {},
    destroyed: false,
    usedFallbackStyle: false,
    webglLost: false,
    renderRafId: null,
    countryPulseRaf: null,
    activeFlightTrails: new Map(),
    layerCache: new Map(),
  });
  for (const name of ['settleViewportMovement', 'stopTradeAnimation', 'stopPulseAnimation',
    'stopDayNightTimer', 'stopWeatherRadar', 'stopLiveTankersLoop']) map[name] = () => {};
  for (const name of ['debouncedRebuildLayers', 'debouncedFetchBases', 'debouncedFetchAircraft',
    'rafUpdateLayers', 'heavyGate']) map[name] = { cancel() {} };
  await map.initMapLibre();
  return {
    map,
    loseContext: () => canvasEvents.webglcontextlost({ preventDefault() {} }),
    expireStyleLoad: () => timeout(),
    counts: () => ({ constructions, removals }),
    cameras,
    warnings,
  };
}

test('context loss retains the primary map until deferred teardown', async () => {
  const { map, loseContext, expireStyleLoad, counts } = await createHarness();
  let center;
  map.onFatalError = () => { center = map.getCenter(); map.destroy(); };
  loseContext();
  expireStyleLoad();
  assert.equal(map.destroyed, false, 'teardown must be deferred');
  await Promise.resolve();
  assert.deepEqual(counts(), { constructions: 1, removals: 1 });
  assert.deepEqual(center, { lat: 48, lon: 12 });
});

test('successful fallback construction preserves the current camera', async () => {
  const { expireStyleLoad, cameras, counts } = await createHarness({ failReplacement: false });
  expireStyleLoad();
  assert.deepEqual(counts(), { constructions: 2, removals: 1 });
  assert.deepEqual(cameras[1], { center: [12, 48], zoom: 5 });
});

test('failed fallback construction retains the last center after primary removal', async () => {
  const { map, expireStyleLoad, counts } = await createHarness();
  let center;
  map.onFatalError = () => { center = map.getCenter(); map.destroy(); };
  expireStyleLoad();
  await Promise.resolve();
  assert.deepEqual(counts(), { constructions: 2, removals: 1 });
  assert.deepEqual(center, { lat: 48, lon: 12 });
});

test('contains a fatal callback exception and reports the callback failure', async () => {
  const pending = [];
  const { map, expireStyleLoad, warnings } = await createHarness({
    scheduleMicrotask: callback => pending.push(callback),
  });
  const failure = new Error('Recovery callback failed');
  const received = [];
  map.onFatalError = error => { received.push(error.message); throw failure; };
  expireStyleLoad();
  assert.equal(pending.length, 1);
  assert.doesNotThrow(() => pending[0]());
  assert.deepEqual(received, ['WebGL2 is required']);
  assert.deepEqual(warnings.at(-1), ['[DeckGLMap] Fatal-error callback failed:', failure]);
});

test('skips a queued fatal callback after the map is destroyed', async () => {
  const pending = [];
  const { map, expireStyleLoad, counts } = await createHarness({
    scheduleMicrotask: callback => pending.push(callback),
  });
  let called = false;
  map.onFatalError = () => { called = true; };
  expireStyleLoad();
  map.destroy();
  assert.equal(pending.length, 1);
  pending[0]();
  assert.equal(called, false);
  assert.deepEqual(counts(), { constructions: 2, removals: 1 });
});
