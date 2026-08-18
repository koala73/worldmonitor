import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8');

describe('DeckGL aircraft fetch state', () => {
  it('invalidates in-flight responses when the layer or map becomes ineligible', () => {
    const timerMethod = source.match(
      /private manageAircraftTimer\(enabled: boolean\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}private hasAircraftViewportChanged)/,
    )?.[0];
    assert.ok(timerMethod, 'manageAircraftTimer must remain discoverable');
    assert.match(
      timerMethod,
      /else \{\s*\/\/ Invalidate[\s\S]+?this\.aircraftFetchSeq \+= 1;\s*this\.setLayerReady\('flights', false\);/,
      'disabling flights must invalidate its pending request and settle loading',
    );

    const viewportMethod = source.match(
      /private fetchViewportAircraft\(\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}public setNaturalEvents)/,
    )?.[0];
    assert.ok(viewportMethod);
    assert.match(
      viewportMethod,
      /if \(zoom < 2\) \{\s*\/\/ Zooming out[\s\S]+?this\.aircraftFetchSeq \+= 1;\s*this\.setLayerReady\('flights', false\);/,
      'zooming out must invalidate its pending request and settle loading',
    );

    const destroyMethod = source.match(/public destroy\(\): void \{[\s\S]+?\n {2}\}/)?.[0];
    assert.ok(destroyMethod);
    assert.match(
      destroyMethod,
      /this\.destroyed = true;\s*this\.aircraftFetchSeq \+= 1;/,
      'destroy must invalidate its pending viewport request',
    );
  });

  it('settles loading when a deferred aircraft request is invalidated', async () => {
    const timerMethod = source.match(
      /private manageAircraftTimer\(enabled: boolean\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}private hasAircraftViewportChanged)/,
    )?.[0];
    const viewportMethod = source.match(
      /private fetchViewportAircraft\(\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}public setNaturalEvents)/,
    )?.[0];
    assert.ok(timerMethod && viewportMethod);
    const harnessJs = ts.transpileModule(
      `class AircraftHarness {\n${timerMethod}\n${viewportMethod}\n}`,
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          useDefineForClassFields: true,
        },
      },
    ).outputText;

    for (const invalidation of ['disable', 'zoom']) {
      let resolveFetch;
      const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
      // eslint-disable-next-line no-new-func
      const Harness = new Function(
        'fetchAircraftPositions',
        'setInterval',
        'clearInterval',
        `${harnessJs}\nreturn AircraftHarness;`,
      )(
        () => pendingFetch,
        () => 1,
        () => {},
      );
      let zoom = 5;
      const readiness = [];
      const loading = [];
      const instance = new Harness();
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
        },
        hasAircraftViewportChanged: () => true,
        setLayerLoading: (layer, value) => loading.push([layer, value]),
        setLayerReady: (layer, value) => readiness.push([layer, value]),
        render: () => {},
        debouncedFetchAircraft: () => {},
      });

      instance.fetchViewportAircraft();
      assert.deepEqual(loading, [['flights', true]], invalidation);
      if (invalidation === 'disable') {
        instance.state.layers.flights = false;
        instance.manageAircraftTimer(false);
      } else {
        zoom = 1;
        instance.fetchViewportAircraft();
      }
      assert.deepEqual(readiness, [['flights', false]], invalidation);

      resolveFetch([{ icao24: 'late' }]);
      await pendingFetch;
      await Promise.resolve();
      assert.deepEqual(instance.aircraftPositions, [], invalidation);
      assert.deepEqual(readiness, [['flights', false]], invalidation);
    }
  });

  it('clears readiness with aircraft data only for the current failed request', () => {
    const fetchMethod = source.match(
      /private fetchViewportAircraft\(\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}public setNaturalEvents)/,
    )?.[0];
    assert.ok(fetchMethod, 'fetchViewportAircraft must remain discoverable');

    const errorHandler = fetchMethod.match(/\.catch\(\(err\) => \{([\s\S]+?)\n {4}\}\);/)?.[1];
    assert.ok(errorHandler, 'aircraft fetch must retain an error handler');
    assert.match(
      errorHandler,
      /if \(seq === this\.aircraftFetchSeq\) \{\s*this\.aircraftPositions = \[\];\s*this\.onAircraftPositionsUpdate\?\.\(\[\]\);\s*this\.setLayerReady\('flights', false\);\s*this\.render\(\);\s*\}/,
      'a current failure must clear both aircraft data and the layer ready state',
    );
    assert.doesNotMatch(
      errorHandler.replace(/if \(seq === this\.aircraftFetchSeq\) \{[\s\S]+?\n {6}\}/, ''),
      /setLayer(?:Loading|Ready)\('flights'/,
      'a stale failure must not settle a newer request\'s loading or ready state',
    );
  });
});
