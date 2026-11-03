import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8');
const ast = ts.createSourceFile('DeckGLMap.ts', source, ts.ScriptTarget.Latest, true);
const mapClass = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'DeckGLMap');
assert.ok(mapClass, 'DeckGLMap class must exist');
const methods = ['manageAircraftTimer', 'fetchViewportAircraft', 'destroy'].map((name) => {
  const method = mapClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method, `${name} method must exist`);
  return method.getText(ast);
});
const harnessJs = ts.transpileModule(`class AircraftHarness {\n${methods.join('\n')}\n}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

function createHarness() {
  const requests = [];
  // Execute the real methods without constructing the WebGL map. Select methods
  // by syntax node so comments, formatting and adjacent methods are irrelevant.
  // eslint-disable-next-line no-new-func
  const Harness = new Function('fetchAircraftPositions', 'window', 'setTrustedHtml', 'trustedHtml', 'console',
    `${harnessJs}\nreturn AircraftHarness;`)(
    () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    { removeEventListener() {} }, () => {}, () => '', { error() {} },
  );
  const instance = new Harness();
  const effects = [];
  const cancelable = () => Object.assign(() => {}, { cancel() {} });
  let zoom = 5;
  Object.assign(instance, {
    aircraftFetchSeq: 0,
    aircraftFetchTimer: null,
    aircraftPositions: [],
    state: { layers: { flights: true } },
    maplibreMap: {
      getZoom: () => zoom,
      getBounds: () => ({
        getSouthWest: () => ({ lat: -10, lng: -20 }),
        getNorthEast: () => ({ lat: 10, lng: 20 }),
      }),
      getCenter: () => ({ lat: 0, lng: 0 }),
      remove() {},
    },
    hasAircraftViewportChanged: () => true,
    setLayerLoading: (layer, value) => effects.push(['loading', layer, value]),
    setLayerReady: (layer, value) => effects.push(['ready', layer, value]),
    onAircraftPositionsUpdate: (positions) => effects.push(['positions', positions]),
    render: () => effects.push(['render']),
    activeFlightTrails: new Map(),
    layerCache: new Map(),
    renderRafId: null,
    countryPulseRaf: null,
    debouncedRebuildLayers: cancelable(),
    debouncedFetchBases: cancelable(),
    debouncedFetchAircraft: cancelable(),
    rafUpdateLayers: cancelable(),
    heavyGate: cancelable(),
    deckFrameProvider: { wake() {}, dispose() {} },
  });
  for (const name of ['settleViewportMovement', 'stopTradeAnimation', 'stopPulseAnimation',
    'stopDayNightTimer', 'stopWeatherRadar', 'stopLiveTankersLoop', 'detachMapLibreInteractionHandlers']) {
    instance[name] = () => {};
  }
  return { instance, requests, effects, zoomOut: () => { zoom = 1; instance.fetchViewportAircraft(); } };
}

// The production method chains then().catch(); flush both continuations.
async function flushFetch() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DeckGL aircraft fetch state', () => {
  for (const invalidation of ['disable', 'zoom', 'destroy']) {
    for (const outcome of ['resolve', 'reject']) {
      it(`ignores a late ${outcome} after ${invalidation}`, async () => {
        const { instance, requests, effects, zoomOut } = createHarness();
        instance.fetchViewportAircraft();
        assert.equal(requests.length, 1);
        assert.deepEqual(effects, [['loading', 'flights', true]]);
        if (invalidation === 'disable') {
          instance.state.layers.flights = false;
          instance.manageAircraftTimer(false);
        } else if (invalidation === 'zoom') {
          zoomOut();
        } else {
          instance.destroy();
          assert.equal(instance.destroyed, true);
        }
        if (invalidation !== 'destroy') {
          assert.ok(effects.some((event) => event[0] === 'ready' && event[2] === false), 'invalidation settles loading');
        }
        const afterInvalidation = [...effects];
        requests[0][outcome](outcome === 'resolve' ? [{ icao24: 'late' }] : new Error('late failure'));
        await flushFetch();
        assert.deepEqual(instance.aircraftPositions, []);
        assert.deepEqual(effects, afterInvalidation, 'a stale completion must not publish data, readiness or render');
      });
    }
  }

  it('publishes a current response and clears data and readiness on a current failure', async () => {
    const { instance, requests, effects } = createHarness();
    instance.fetchViewportAircraft();
    const positions = [{ icao24: 'current' }];
    requests[0].resolve(positions);
    await flushFetch();
    assert.deepEqual(instance.aircraftPositions, positions);
    assert.deepEqual(effects, [
      ['loading', 'flights', true], ['positions', positions], ['ready', 'flights', true], ['render'],
    ]);
    effects.length = 0;
    instance.fetchViewportAircraft();
    requests[1].reject(new Error('current failure'));
    await flushFetch();
    assert.deepEqual(instance.aircraftPositions, []);
    assert.deepEqual(effects, [
      ['loading', 'flights', true], ['positions', []], ['ready', 'flights', false], ['render'],
    ]);
  });

  for (const outcome of ['resolve', 'reject']) {
    it(`does not settle a newer request when an older request ${outcome}s`, async () => {
      const { instance, requests, effects } = createHarness();
      instance.fetchViewportAircraft();
      instance.fetchViewportAircraft();
      assert.equal(requests.length, 2);
      effects.length = 0;
      requests[0][outcome](outcome === 'resolve' ? [{ icao24: 'old' }] : new Error('old failure'));
      await flushFetch();
      assert.deepEqual(effects, []);
      const positions = [{ icao24: 'new' }];
      requests[1].resolve(positions);
      await flushFetch();
      assert.deepEqual(instance.aircraftPositions, positions);
      assert.deepEqual(effects, [['positions', positions], ['ready', 'flights', true], ['render']]);
    });
  }
});
