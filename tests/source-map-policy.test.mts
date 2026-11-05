import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  removeSourceMaps,
  shouldEmitPublicSourceMaps,
  viteSourcemapSetting,
} from '../shared/source-map-policy.ts';

describe('source map policy', () => {
  it('never publishes maps from a production deploy, even when opted in', () => {
    assert.equal(shouldEmitPublicSourceMaps({ VERCEL_ENV: 'production' }), false);
    assert.equal(shouldEmitPublicSourceMaps({ VERCEL_ENV: 'production', WM_EMIT_SOURCEMAPS: '1' }), false);
  });

  it('publishes maps on previews and on opted-in local builds', () => {
    assert.equal(shouldEmitPublicSourceMaps({ VERCEL_ENV: 'preview' }), true);
    assert.equal(shouldEmitPublicSourceMaps({ WM_EMIT_SOURCEMAPS: '1' }), true);
    assert.equal(shouldEmitPublicSourceMaps({}), false);
  });

  it('builds hidden maps for the Sentry upload only, so bundles carry no sourceMappingURL', () => {
    assert.equal(viteSourcemapSetting({ VERCEL_ENV: 'production', SENTRY_AUTH_TOKEN: 't' }), 'hidden');
    assert.equal(viteSourcemapSetting({ VERCEL_ENV: 'production', SENTRY_AUTH_TOKEN: 't', WM_EMIT_SOURCEMAPS: '1' }), 'hidden');
    assert.equal(viteSourcemapSetting({ VERCEL_ENV: 'production' }), false);
    assert.equal(viteSourcemapSetting({ VERCEL_ENV: 'preview', SENTRY_AUTH_TOKEN: 't' }), true);
    assert.equal(viteSourcemapSetting({}), false);
  });

  it('removes every map left in the output tree and keeps everything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-maps-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await mkdir(join(dir, 'pro', 'assets'), { recursive: true });
    const files = {
      'assets/main-abc.js': 'x',
      'assets/main-abc.js.map': '{}',
      'assets/main-abc.js.map.br': 'x',
      'assets/style-abc.css.map': '{}',
      'pro/assets/index-def.js.map': '{}',
      'pro/assets/index-def.js': 'x',
      'sitemap.xml': 'x',
      'index.html': 'x',
    };
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);

    const removed = await removeSourceMaps(dir);

    assert.deepEqual(removed.sort(), [
      'assets/main-abc.js.map',
      'assets/main-abc.js.map.br',
      'assets/style-abc.css.map',
      'pro/assets/index-def.js.map',
    ]);
    const left = (await readdir(dir, { recursive: true })).filter((p) => p.includes('.')).sort();
    assert.deepEqual(left, ['assets/main-abc.js', 'index.html', 'pro/assets/index-def.js', 'sitemap.xml']);
  });

  it('treats a missing output directory as nothing to remove', async () => {
    assert.deepEqual(await removeSourceMaps(join(tmpdir(), 'wm-maps-does-not-exist')), []);
  });
});
