import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticAssetUrl } from '../src/config/static-asset-url.ts';

const BUNDLE = 'https://www.worldmonitor.app/plugin/assets/boot-1/plugin-abc.js';

describe('resolveStaticAssetUrl', () => {
  it('loads from the bundle origin when the view runs in a host sandbox', () => {
    assert.equal(
      resolveStaticAssetUrl('/data/countries.geojson', BUNDLE, 'https://ff53229891a07f66badf067413d21664.claudemcpcontent.com'),
      'https://www.worldmonitor.app/data/countries.geojson',
    );
  });

  it('loads from the bundle origin in an opaque sandbox', () => {
    assert.equal(resolveStaticAssetUrl('/textures/earth-topo-bathy.jpg', BUNDLE, 'null'), 'https://www.worldmonitor.app/textures/earth-topo-bathy.jpg');
  });

  it('keeps the path when page and bundle share an origin', () => {
    assert.equal(resolveStaticAssetUrl('/data/countries-50m.json', BUNDLE, 'https://www.worldmonitor.app'), '/data/countries-50m.json');
    assert.equal(resolveStaticAssetUrl('/data/countries.geojson', 'tauri://localhost/assets/main.js', 'tauri://localhost'), '/data/countries.geojson');
  });

  it('keeps the path when the bundle was not loaded over HTTP or there is no page', () => {
    assert.equal(resolveStaticAssetUrl('/data/countries.geojson', 'file:///repo/src/config/static-asset-url.ts', 'http://localhost:3000'), '/data/countries.geojson');
    assert.equal(resolveStaticAssetUrl('/data/countries.geojson', BUNDLE, undefined), '/data/countries.geojson');
  });

  it('leaves an absolute override URL as it is', () => {
    assert.equal(resolveStaticAssetUrl('https://maps.worldmonitor.app/overrides.geojson', BUNDLE, 'null'), 'https://maps.worldmonitor.app/overrides.geojson');
  });
});
