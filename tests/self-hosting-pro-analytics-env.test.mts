import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { build } from 'esbuild';
import type { ConfigEnv, UserConfig } from 'vite';

const STRIP_PLUGIN = 'wm-strip-static-umami-tags';
const originalEnv = { ...process.env };
let envDir: string;
let loadMarketing: (env: ConfigEnv) => UserConfig;

function stripsUmami(config: UserConfig): boolean {
  const plugins: unknown[] = config.plugins ?? [];
  return plugins.flat(Infinity).some(p => p && typeof p === 'object' && 'name' in p && p.name === STRIP_PLUGIN);
}

function proBuild(mode: string): boolean {
  return stripsUmami(loadMarketing({ mode, command: 'build' }));
}

before(async () => {
  delete process.env.VITE_ANALYTICS_ENABLED;
  delete process.env.SENTRY_AUTH_TOKEN;
  const cache = resolve('pro-test/node_modules/.cache');
  await mkdir(cache, { recursive: true });
  envDir = await mkdtemp(join(cache, 'pro-analytics-env-test-'));
  await writeFile(join(envDir, '.env.production'), 'VITE_ANALYTICS_ENABLED=false\n');
  await writeFile(join(envDir, '.env.staging'), 'VITE_ANALYTICS_ENABLED=true\n');
  const outfile = join(envDir, 'marketing.mjs');
  await build({
    entryPoints: ['pro-test/vite.config.ts'], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { __dirname: JSON.stringify(envDir) },
  });
  loadMarketing = (await import(pathToFileURL(outfile).href)).default;
});

afterEach(() => {
  delete process.env.VITE_ANALYTICS_ENABLED;
});

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  if (envDir) await rm(envDir, { recursive: true, force: true });
});

describe('pro-test build reads VITE_ANALYTICS_ENABLED from its env files', () => {
  it('keeps the Umami tags when neither a file nor the shell sets the switch', () => {
    assert.equal(proBuild('development'), false);
  });

  it('strips the Umami tags when only the mode env file sets false', () => {
    assert.equal(proBuild('production'), true);
  });

  it('lets a shell true override a file false', () => {
    process.env.VITE_ANALYTICS_ENABLED = 'true';
    assert.equal(proBuild('production'), false);
  });

  it('lets a shell false override a file true', () => {
    process.env.VITE_ANALYTICS_ENABLED = 'false';
    assert.equal(proBuild('staging'), true);
  });
});
