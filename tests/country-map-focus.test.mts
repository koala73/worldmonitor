import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  focusFromCountryBbox,
  getCountryMapFocus,
  wrappingBboxFromPolygons,
} from '../src/app/country-map-focus.ts';

describe('country map focus zoom buckets', () => {
  it('centers the bbox and uses the dashboard country-map zoom buckets', () => {
    assert.deepEqual(focusFromCountryBbox([-10, 0, 40, 50]), {
      lat: 25,
      lon: 15,
      zoom: 3,
    });
    assert.deepEqual(focusFromCountryBbox([0, 0, 20, 16]), {
      lat: 8,
      lon: 10,
      zoom: 4,
    });
    assert.deepEqual(focusFromCountryBbox([0, 0, 8, 6]), {
      lat: 3,
      lon: 4,
      zoom: 5,
    });
    assert.deepEqual(focusFromCountryBbox([8, 50, 10, 52]), {
      lat: 51,
      lon: 9,
      zoom: 6,
    });
  });

  it('returns null for an unknown ISO2 while geometry is unloaded', () => {
    assert.equal(getCountryMapFocus('XX'), null);
    assert.equal(getCountryMapFocus('de'), null);
  });

  it('centers wrap-around countries on the tight longitude arc, not 0°', () => {
    const russia = wrappingBboxFromPolygons([
      [[[20, 41], [40, 41], [100, 70], [180, 65], [180, 55], [20, 41]]],
      [[[-170, 65], [-180, 65], [-180, 60], [-170, 60], [-170, 65]]],
    ]);
    assert.ok(russia);
    const [west, , east] = russia;
    assert.ok(east - west < 200, `span should be Russia-wide, not 360°: ${east - west}`);
    const focus = focusFromCountryBbox(russia);
    assert.ok(focus.lon > 60 && focus.lon < 140, `Russia center should be Siberia, not ${focus.lon}`);
    assert.equal(focus.zoom, 3);

    const fiji = wrappingBboxFromPolygons([
      [[[177, -19], [180, -19], [180, -16], [177, -16], [177, -19]]],
      [[[-180, -19], [-178, -19], [-178, -16], [-180, -16], [-180, -19]]],
    ]);
    assert.ok(fiji);
    const fijiFocus = focusFromCountryBbox(fiji);
    assert.ok(
      Math.abs(fijiFocus.lon) > 170,
      `Fiji should stay in the Pacific, not ${fijiFocus.lon}`,
    );
  });

  it('keeps a contiguous country on its naive longitude interval', () => {
    const bbox = wrappingBboxFromPolygons([
      [[[6, 47], [15, 47], [15, 55], [6, 55], [6, 47]]],
    ]);
    assert.deepEqual(bbox, [6, 47, 15, 55]);
    assert.deepEqual(focusFromCountryBbox(bbox!), {
      lat: 51,
      lon: 10.5,
      zoom: 5,
    });
  });

  it('focuses bundled Russia on the Eurasian arc, not 0°', async () => {
    const geojson = JSON.parse(
      await readFile(fileURLToPath(new URL('../public/data/countries.geojson', import.meta.url)), 'utf8'),
    ) as unknown;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === '/data/countries.geojson') {
        return Promise.resolve(new Response(JSON.stringify(geojson), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === 'https://maps.worldmonitor.app/country-boundary-overrides.geojson') {
        return Promise.resolve(new Response(JSON.stringify({
          type: 'FeatureCollection',
          features: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as typeof fetch;

    try {
      const geometry = await import(
        `../src/services/country-geometry.ts?focus=${Date.now()}-${Math.random()}`
      );
      await geometry.preloadCountryGeometry();
      const naive = geometry.getCountryBbox('RU') as [number, number, number, number] | null;
      assert.ok(naive);
      assert.ok(naive[2] - naive[0] > 300, `bundled Russia AABB should still span 360°: ${naive.join(',')}`);
      const polygons = geometry.getCountryPolygons('RU');
      assert.ok(polygons);
      const wrap = wrappingBboxFromPolygons(polygons);
      assert.ok(wrap);
      assert.ok(wrap[2] - wrap[0] < 200, `wrapped Russia span should not be 360°: ${wrap[2] - wrap[0]}`);
      const focus = focusFromCountryBbox(wrap);
      assert.ok(focus.lon > 60 && focus.lon < 140, `Russia center should be Siberia, not ${focus.lon}`);
      assert.equal(focus.zoom, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
