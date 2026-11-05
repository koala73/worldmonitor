import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  removeSourceMaps,
  shouldEmitPublicSourceMaps,
  viteSourcemapSetting,
} from '../shared/source-map-policy.ts';
import { findPublicSourceMapLeaks } from '../scripts/check-no-public-source-maps.mjs';

const root = join(import.meta.dirname, '..');

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wm-maps-'));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

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
    const dir = await tree({
      'assets/main-abc.js': 'x',
      'assets/main-abc.js.map': '{}',
      'assets/main-abc.js.map.br': 'x',
      'assets/style-abc.css.map': '{}',
      'pro/assets/index-def.js.map': '{}',
      'pro/assets/index-def.js': 'x',
      'sitemap.xml': 'x',
      'index.html': 'x',
    });

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

describe('check-no-public-source-maps deploy gate', () => {
  const script = join(root, 'scripts', 'check-no-public-source-maps.mjs');

  function runGate(dir: string, env: Record<string, string>) {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.VERCEL_ENV;
    delete cleanEnv.WM_EMIT_SOURCEMAPS;
    return spawnSync(process.execPath, ['--import', 'tsx', script, dir], {
      cwd: root,
      env: { ...cleanEnv, ...env },
      encoding: 'utf8',
    });
  }

  it('finds map files, sourceMappingURL pragmas and inline maps anywhere in the tree', async () => {
    const dir = await tree({
      'assets/a.js': 'x\n//# sourceMappingURL=a.js.map',
      'assets/b.css': 'a{}\n/*# sourceMappingURL=b.css.map */',
      'pro/assets/c.js': 'x\n//# sourceMappingURL=data:application/json;base64,e30=',
      'sw.js.map': '{}',
      'blog/_astro/d.js.map.br': 'x',
      'assets/clean.js': 'const sourceMappingURL = "not a pragma";',
      'index.html': '<p>sourceMappingURL</p>',
      'blog/post/index.html': '<script>x()\n//# sourceMappingURL=data:application/json;base64,e30=\n</script>',
      'pro/index.html': '<style>a{}\n/*# sourceMappingURL=data:application/json;base64,e30= */</style>',
    });
    assert.deepEqual(await findPublicSourceMapLeaks(dir), {
      mapFiles: ['blog/_astro/d.js.map.br', 'sw.js.map'],
      referencingFiles: ['assets/a.js', 'assets/b.css', 'blog/post/index.html', 'pro/assets/c.js', 'pro/index.html'],
    });
  });

  it('fails a production build that would publish a map, and names the file', async () => {
    const dir = await tree({ 'assets/a.js': 'x', 'sw.js.map': '{}' });
    const result = runGate(dir, { VERCEL_ENV: 'production', WM_EMIT_SOURCEMAPS: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /sw\.js\.map/);
  });

  it('fails a production build whose bundle still points at a map', async () => {
    const dir = await tree({ 'assets/a.js': 'x\n//# sourceMappingURL=a.js.map' });
    const result = runGate(dir, { VERCEL_ENV: 'production' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /assets\/a\.js/);
  });

  it('passes a clean production build and skips previews', async () => {
    const clean = await tree({ 'assets/a.js': 'x', 'index.html': '<p>' });
    assert.equal(runGate(clean, { VERCEL_ENV: 'production' }).status, 0);
    const leaky = await tree({ 'assets/a.js.map': '{}' });
    assert.equal(runGate(leaky, { VERCEL_ENV: 'preview' }).status, 0);
  });

  it('runs at the end of the Vercel build command', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
    assert.equal(vercel.buildCommand, 'npm run build:full');
    assert.match(pkg.scripts['build:full'], /&& npm run check:source-maps$/);
    assert.match(pkg.scripts['check:source-maps'], /scripts\/check-no-public-source-maps\.mjs dist$/);
  });
});

describe('bundler configs that ship to production', () => {
  // Every config here was reviewed for source-map output. A new bundler
  // config must follow shared/source-map-policy.ts before it joins this list.
  const REVIEWED = ['blog-site/astro.config.mjs', 'pro-test/vite.config.ts', 'vite.config.ts', 'vite.plugin.config.ts'];

  it('has no unreviewed bundler config', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
    const configs = tracked
      .filter((p) => /(^|\/)(vite|astro|rollup|webpack|esbuild|rspack|tsup)(\.[\w-]+)?\.config\.(c|m)?[jt]s$/.test(p))
      .sort();
    assert.deepEqual(configs, REVIEWED);
  });

  it('builds production maps only as hidden upload input', async () => {
    const read = (p: string) => readFile(join(root, p), 'utf8');
    const main = await read('vite.config.ts');
    assert.match(main, /sourcemap:\s*viteSourcemapSetting\(process\.env\)/);
    assert.match(main, /sourcemap:\s*emitPublicSourceMaps,\n\s*globPatterns/);
    assert.match(main, /emitPublicSourceMaps \? \[\] : \[stripPrivateSourceMapsPlugin\(\)\]/);
    assert.match(await read('pro-test/vite.config.ts'), /sourcemap:\s*uploadSourceMapsToSentry \? 'hidden' : false/);
    assert.doesNotMatch(await read('vite.plugin.config.ts'), /sourcemap/i);
    assert.doesNotMatch(await read('blog-site/astro.config.mjs'), /sourcemap/i);
  });
});
