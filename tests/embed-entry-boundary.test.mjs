import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('embed entry boundary', () => {
  it('boots the shared map container while staying out of the authenticated app shell', () => {
    const files = [
      'src/embed-main.ts',
      'src/embed/embed-data-loader.ts',
      'src/embed/embed-url.ts',
      'src/embed/embed-credential.ts',
      'src/embed/embed-fetch.ts',
      'src/embed/panels/map.ts',
      'src/embed/panels/chokepoint-strip.ts',
      'src/embed/panels/fear-greed.ts',
    ];
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf-8')).join('\n');
    assert.ok(
      source.includes('@/components/MapContainer'),
      'embed entry should use the shared current map container rather than booting a legacy map directly',
    );

    const forbidden = [
      '@/App',
      '@/app/panel-layout',
      '@/services/auth-state',
      '@/services/clerk',
      '@/services/cloud-preferences',
      '@/services/push-notifications',
      '@/services/runtime',
      '@/components/Panel',
      '@/components/ChokepointStripPanel',
      '@/components/FearGreedPanel',
    ];
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `embed entry must not import ${token}`);
    }
  });

  it('starts the credential waiter before awaiting initI18n so load-time postMessage is not dropped', () => {
    const source = readFileSync(resolve(root, 'src/embed-main.ts'), 'utf-8');
    const waitIdx = source.indexOf('waitForEmbeddingApiKey()');
    const i18nIdx = source.indexOf('await initI18n()');
    assert.ok(waitIdx !== -1, 'keyed boot must call waitForEmbeddingApiKey()');
    assert.ok(i18nIdx !== -1, 'boot must await initI18n()');
    assert.ok(waitIdx < i18nIdx, 'waitForEmbeddingApiKey() must start before await initI18n()');
  });

  it('reaches the network only through the single composed map-frame endpoint', () => {
    const loaderSource = readFileSync(resolve(root, 'src/embed/embed-data-loader.ts'), 'utf-8');
    const mapSource = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(loaderSource.includes('fetchEmbedMapFrame'), 'embed loader should read the composed map frame');
    assert.ok(loaderSource.includes('this.map.setConflictEvents'), 'conflicts layer should push events into the flat map');
    assert.ok(mapSource.includes('setConflictEvents'), 'flat map should expose a conflict event setter for the embed');
    assert.ok(mapSource.includes('conflict-event-marker'), 'flat map should render fetched conflict event markers');

    // The point of the composed endpoint is that a credential published in
    // partner HTML reaches ONE path. A per-layer fetch reintroduced here would
    // reopen the surface PR3 then removes from the anonymous RPC allowlist.
    for (const forbidden of [
      'ConflictServiceClient',
      'listAcledEvents',
      'fetchEarthquakes',
      'fetchNaturalEvents',
      'fetchProtestEvents',
      'fetchWeatherAlerts',
      '/api/bootstrap',
      'globalThis.fetch',
    ]) {
      assert.ok(
        !loaderSource.includes(forbidden),
        `embed loader must not fetch layers directly (found ${forbidden})`,
      );
    }
    assert.ok(!loaderSource.includes('@/services/conflict'), 'embed loader must not import the full conflict service because it pulls runtime app helpers');
  });

  it('renders the attribution link before any tier is known', () => {
    const mapPanel = readFileSync(resolve(root, 'src/embed/panels/map.ts'), 'utf-8');
    const attributionIdx = mapPanel.indexOf('buildWorldMonitorAttributionUrl');
    const loaderIdx = mapPanel.indexOf('new EmbedDataLoader');
    const requestGrantIdx = mapPanel.indexOf('loader.requestGrant');
    assert.ok(attributionIdx !== -1, 'the map panel must render an attribution link');
    assert.ok(
      attributionIdx < loaderIdx && attributionIdx < requestGrantIdx,
      'attribution is appended before any tier decision, so free and keyed embeds both carry it',
    );
  });

  it('never sends the embedding key on a data poll', () => {
    const fetchSource = readFileSync(resolve(root, 'src/embed/embed-fetch.ts'), 'utf-8');
    const frameFn = fetchSource.slice(fetchSource.indexOf('export async function fetchEmbedMapFrame'));
    assert.ok(frameFn.includes('X-WorldMonitor-Grant'), 'map-frame polls carry the short-lived grant');
    assert.ok(
      !frameFn.includes('X-WorldMonitor-Key'),
      'the wme_ key must stay on the mint path so polls never enter the per-account meter',
    );
  });

  it('keeps the shared SVG map independent of runtime/auth imports used by the app shell', () => {
    const source = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(!source.includes("@/services/runtime"), 'Map.ts must not import services/runtime because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/auth-state"), 'Map.ts must not import auth-state because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/clerk"), 'Map.ts must not import Clerk because the public embed imports Map.ts');
  });
});
