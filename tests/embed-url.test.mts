import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmbedIframeSnippet,
  buildEmbedLoaderSnippet,
  buildEmbedMapUrl,
  buildEmbedPanelUrl,
  createBlankMapLayers,
  embedLayerIdsFromMapLayers,
  parseEmbedParams,
} from '../src/embed/embed-url';

describe('embed URL contract', () => {
  it('defaults to a small public map-layer set', () => {
    const parsed = parseEmbedParams('');
    assert.deepEqual(parsed.layerIds, ['conflicts', 'earthquakes', 'weather']);
    assert.equal(parsed.layers.conflicts, true);
    assert.equal(parsed.layers.natural, true);
    assert.equal(parsed.layers.weather, true);
    assert.equal(parsed.layers.protests, false);
    assert.deepEqual(parsed.center, { lat: 20, lon: 0 });
    assert.equal(parsed.zoom, 1);
    assert.equal(parsed.theme, 'dark');
    assert.equal(parsed.variant, 'full');
    assert.equal(parsed.panel, 'map');
    assert.equal(parsed.requestedPanel, '');
  });

  it('accepts allowlisted ?panel= ids and keeps unknown ids from rendering', () => {
    assert.equal(parseEmbedParams('?panel=chokepoint-strip').panel, 'chokepoint-strip');
    assert.equal(parseEmbedParams('?panel=fear-greed').panel, 'fear-greed');
    assert.equal(parseEmbedParams('?panel=live-map').panel, 'map');
    const unknown = parseEmbedParams('?panel=intel');
    assert.equal(unknown.panel, null);
    assert.equal(unknown.requestedPanel, 'intel');
  });

  it('never treats a query-string key as an embedding credential', () => {
    const parsed = parseEmbedParams('?panel=fear-greed&key=wm_0123456789abcdef0123456789abcdef01234567');
    assert.equal(parsed.panel, 'fear-greed');
    assert.equal('key' in parsed, false);
    assert.equal(parsed.apiKey, undefined);
  });

  it('accepts public live and static map layers while mapping earthquakes to the natural map layer', () => {
    const parsed = parseEmbedParams('?layers=conflicts,earthquakes,protests,weather,pipelines,waterways,tradeRoutes,stockExchanges,financialCenters,centralBanks');
    assert.deepEqual(parsed.layerIds, [
      'conflicts',
      'earthquakes',
      'protests',
      'weather',
      'pipelines',
      'waterways',
      'tradeRoutes',
      'stockExchanges',
      'financialCenters',
      'centralBanks',
    ]);
    assert.equal(parsed.layers.conflicts, true);
    assert.equal(parsed.layers.natural, true);
    assert.equal(parsed.layers.protests, true);
    assert.equal(parsed.layers.weather, true);
    assert.equal(parsed.layers.pipelines, true);
    assert.equal(parsed.layers.waterways, true);
    assert.equal(parsed.layers.tradeRoutes, true);
    assert.equal(parsed.layers.stockExchanges, true);
    assert.equal(parsed.layers.financialCenters, true);
    assert.equal(parsed.layers.centralBanks, true);
  });

  it('keeps aliases as inputs but emits canonical layer ids', () => {
    const parsed = parseEmbedParams('?layers=natural,conflict,protest,earthquake,trade-route,stock-exchanges,central-bank');
    assert.deepEqual(parsed.layerIds, ['earthquakes', 'conflicts', 'protests', 'tradeRoutes', 'stockExchanges', 'centralBanks']);
  });

  it('drops premium, authenticated, and high-frequency layers from public embeds', () => {
    const parsed = parseEmbedParams('?layers=ais,flights,military,liveTankers,webcams,satellites,sanctions,resilienceScore,ciiChoropleth,conflicts');
    assert.deepEqual(parsed.layerIds, ['conflicts']);
    assert.equal(parsed.layers.ais, false);
    assert.equal(parsed.layers.flights, false);
    assert.equal(parsed.layers.military, false);
    assert.equal(parsed.layers.liveTankers, false);
    assert.equal(parsed.layers.webcams, false);
    assert.equal(parsed.layers.satellites, false);
    assert.equal(parsed.layers.sanctions, false);
    assert.equal(parsed.layers.resilienceScore, false);
    assert.equal(parsed.layers.ciiChoropleth, false);
  });

  it('validates and clamps center, zoom, theme, and variant', () => {
    const parsed = parseEmbedParams('?layers=none&center=140,-240&zoom=99&theme=light&variant=energy');
    assert.deepEqual(parsed.layerIds, []);
    assert.deepEqual(parsed.center, { lat: 90, lon: -180 });
    assert.equal(parsed.zoom, 10);
    assert.equal(parsed.theme, 'light');
    assert.equal(parsed.variant, 'energy');

    const fallback = parseEmbedParams('?center=not,a-number&zoom=Infinity&theme=system&variant=admin');
    assert.deepEqual(fallback.center, { lat: 20, lon: 0 });
    assert.equal(fallback.zoom, 1);
    assert.equal(fallback.theme, 'dark');
    assert.equal(fallback.variant, 'full');
  });

  it('builds a narrow embed URL with no main-app state params', () => {
    const layers = createBlankMapLayers();
    layers.conflicts = true;
    layers.ais = true;
    layers.weather = true;
    const url = buildEmbedMapUrl('https://www.worldmonitor.app/embed?country=US&expanded=true', {
      layers,
      center: { lat: 25.12345, lon: 55.98765 },
      zoom: 4.567,
      theme: 'light',
      variant: 'finance',
    });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/embed');
    assert.equal(parsed.searchParams.get('layers'), 'conflicts,weather');
    assert.equal(parsed.searchParams.get('center'), '25.123,55.988');
    assert.equal(parsed.searchParams.get('zoom'), '4.57');
    assert.equal(parsed.searchParams.get('theme'), 'light');
    assert.equal(parsed.searchParams.get('variant'), 'finance');
    for (const forbidden of ['lat', 'lon', 'view', 'timeRange', 'country', 'expanded']) {
      assert.equal(parsed.searchParams.has(forbidden), false, `${forbidden} must not be in the public embed contract`);
    }
  });

  it('derives only public embed layer ids from a full map layer object', () => {
    const layers = createBlankMapLayers();
    layers.weather = true;
    layers.protests = true;
    layers.pipelines = true;
    layers.stockExchanges = true;
    layers.ais = true;
    layers.ciiChoropleth = true;
    assert.deepEqual(embedLayerIdsFromMapLayers(layers), ['protests', 'weather', 'pipelines', 'stockExchanges']);
  });

  it('escapes iframe snippet attributes', () => {
    const snippet = buildEmbedIframeSnippet('https://www.worldmonitor.app/embed?layers=weather&x="><script>');
    assert.ok(snippet.includes('title="World Monitor live map"'));
    assert.ok(snippet.includes('loading="lazy"'));
    assert.ok(snippet.includes('referrerpolicy="strict-origin-when-cross-origin"'));
    assert.ok(snippet.includes('&quot;&gt;&lt;script&gt;'));
    assert.ok(!snippet.includes('"><script>'));
  });

  it('builds panel URLs and a script-tag loader snippet without putting the API key in the iframe URL', () => {
    const url = buildEmbedPanelUrl('https://www.worldmonitor.app/embed', {
      panel: 'fear-greed',
      theme: 'light',
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('panel'), 'fear-greed');
    assert.equal(parsed.searchParams.get('theme'), 'light');
    assert.equal(parsed.searchParams.has('key'), false);

    const snippet = buildEmbedLoaderSnippet({
      src: 'https://www.worldmonitor.app/embed.js',
      panel: 'chokepoint-strip',
      theme: 'dark',
      height: '360',
    });
    assert.ok(snippet.includes('src="https://www.worldmonitor.app/embed.js"'));
    assert.ok(snippet.includes('data-panel="chokepoint-strip"'));
    assert.ok(snippet.includes('data-key="YOUR_WM_API_KEY"'));
    assert.ok(!snippet.includes('wm_'), 'documented snippet must use a placeholder, not a real key');
  });
});
