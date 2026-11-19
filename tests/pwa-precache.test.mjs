import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appChunkRuntimeCache, createDashboardPrecache } from '../shared/pwa-precache.ts';

function chunk(fileName, { name = fileName, imports = [], dynamicImports = [], css = [], isEntry = false } = {}) {
  return { type: 'chunk', fileName, name, isEntry, imports, dynamicImports, viteMetadata: { importedCss: new Set(css) } };
}

function collect(precache, bundle) {
  precache.plugin.generateBundle({}, bundle);
}

const entriesFor = (bundle) => Object.keys(bundle).map((url) => ({ url, revision: null, size: 100 }));

describe('dashboard PWA precache', () => {
  it('keeps only the entry, transitive static imports and their CSS, even with cycles', async () => {
    const bundle = {
      'assets/main.js': chunk('assets/main.js', { name: 'main', isEntry: true, imports: ['assets/shared.js'], dynamicImports: ['assets/App.js'], css: ['assets/main.css'] }),
      'assets/shared.js': chunk('assets/shared.js', { imports: ['assets/util.js', 'https://example.org/external.js'], css: ['assets/shared.css'] }),
      'assets/util.js': chunk('assets/util.js', { imports: ['assets/main.js'] }),
      'assets/App.js': chunk('assets/App.js', { imports: ['assets/maplibre.js'], css: ['assets/App.css'] }),
      'assets/maplibre.js': chunk('assets/maplibre.js'),
      'assets/settings.js': chunk('assets/settings.js', { name: 'settings', isEntry: true }),
      'assets/main.css': { type: 'asset' },
      'assets/shared.css': { type: 'asset' },
      'assets/App.css': { type: 'asset' },
      'blog/cover.png': { type: 'asset' },
      'assets/font.woff2': { type: 'asset' },
    };
    const precache = createDashboardPrecache();
    collect(precache, bundle);

    const result = await precache.manifestTransform(entriesFor(bundle));

    assert.deepEqual(result.manifest.map(({ url }) => url).sort(), [
      'assets/main.css', 'assets/main.js', 'assets/shared.css', 'assets/shared.js', 'assets/util.js',
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it('replaces the collected files on rebuild instead of retaining old hashes', async () => {
    const precache = createDashboardPrecache();
    const before = { 'assets/main-old.js': chunk('assets/main-old.js', { name: 'main', isEntry: true }) };
    const after = { 'assets/main-new.js': chunk('assets/main-new.js', { name: 'main', isEntry: true }) };
    collect(precache, before);
    collect(precache, after);
    const result = await precache.manifestTransform(entriesFor({ ...before, ...after }));
    assert.deepEqual(result.manifest.map(({ url }) => url), ['assets/main-new.js']);
  });

  it('fails closed when the dashboard entry or its required cache files are missing', async () => {
    const precache = createDashboardPrecache();
    assert.throws(() => precache.manifestTransform([]), /has not been collected/);
    assert.throws(() => collect(precache, {}), /dashboard entry is missing/);
    collect(precache, { 'assets/main.js': chunk('assets/main.js', { name: 'main', isEntry: true }) });
    await assert.rejects(async () => precache.manifestTransform([]), /precache is missing: assets\/main.js/);
  });
});

describe('optional app chunk runtime cache', () => {
  it('matches only same-origin JS and CSS assets', () => {
    for (const path of ['/assets/panels-risk-abc.js', '/assets/maplibre-abc.js?v=1', '/assets/App-abc.css']) {
      assert.equal(appChunkRuntimeCache.urlPattern({ url: new URL(path, 'https://www.worldmonitor.app'), sameOrigin: true }), true);
    }
    for (const path of ['/api/example.js', '/dashboard', '/assets/font.woff2', '/assets/data.json', '/assets/script.js/other']) {
      assert.equal(appChunkRuntimeCache.urlPattern({ url: new URL(path, 'https://www.worldmonitor.app'), sameOrigin: true }), false);
    }
    assert.equal(appChunkRuntimeCache.urlPattern({ url: new URL('https://example.org/assets/script.js'), sameOrigin: false }), false);
    assert.equal(appChunkRuntimeCache.handler, 'StaleWhileRevalidate');
    assert.deepEqual(appChunkRuntimeCache.options.cacheableResponse.statuses, [200]);
  });
});
