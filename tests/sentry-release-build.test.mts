import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, afterEach, before, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BrowserClient, Scope } from '@sentry/browser';
import type { BrowserOptions, ErrorEvent } from '@sentry/browser';
import type { Envelope } from '@sentry/core';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import type { ConfigEnv, UserConfig } from 'vite';
import { Window } from 'happy-dom';

const originalEnv = { ...process.env };
const sha = '0123456789abcdef0123456789abcdef01234567';
let scratch: string;
let loadDashboard: (env: ConfigEnv) => UserConfig;
let marketingConfigUrl: string;
const initializers: Array<() => Promise<BrowserOptions>> = [];
type UploadOptions = NonNullable<Parameters<typeof sentryVitePlugin>[0]>;

function uploadOptions(config: UserConfig): NonNullable<UploadOptions['release']> {
  const plugins: unknown[] = config.plugins ?? [];
  const plugin = plugins.flat(Infinity).find(p => p && typeof p === 'object' && 'name' in p && p.name === 'sentry-upload');
  assert.ok(plugin && typeof plugin === 'object' && 'options' in plugin);
  const options = plugin.options as UploadOptions;
  assert.ok(options.release);
  return options.release;
}

before(async () => {
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(typeof version, 'string');
  const cache = resolve('pro-test/node_modules/.cache');
  await mkdir(cache, { recursive: true });
  scratch = await mkdtemp(join(cache, 'sentry-release-test-'));
  // Execute both real configs, replacing only the upload boundary. No token
  // or network access is needed to observe what we pass to the Sentry plugin.
  for (const [name, entry] of [['dashboard', 'vite.config.ts'], ['marketing', 'pro-test/vite.config.ts']]) {
    await build({
      entryPoints: [entry], outfile: join(scratch, `${name}.mjs`),
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { __dirname: JSON.stringify(resolve(name === 'dashboard' ? '.' : 'pro-test')) },
      plugins: [{
        name: 'capture-sentry-upload-options',
        setup(bundler) {
          bundler.onResolve({ filter: /^@sentry\/vite-plugin$/ }, () => ({ path: 'sentry-upload', namespace: 'test' }));
          bundler.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const sentryVitePlugin = options => ({ name: "sentry-upload", options });',
          }));
        },
      }],
    });
  }
  loadDashboard = (await import(pathToFileURL(join(scratch, 'dashboard.mjs')).href)).default;
  marketingConfigUrl = pathToFileURL(join(scratch, 'marketing.mjs')).href;
  for (const [name, entry, initialize] of [
    ['dashboard', 'src/bootstrap/sentry-init.ts', 'loadAndInitSentry'],
    ['marketing', 'pro-test/src/sentry.ts', 'initSentry'],
  ]) {
    const outfile = join(scratch, `${name}-init.mjs`);
    await build({
      stdin: { contents: `import { ${initialize} } from ${JSON.stringify(resolve(entry))}; import { captured } from 'capture-sdk'; export default async () => { await ${initialize}(); return captured(); };`, resolveDir: resolve('.') },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { __APP_VERSION__: JSON.stringify(version), __BUILD_HASH__: JSON.stringify(sha), 'import.meta.env.VITE_SENTRY_DSN': '"https://public@example.invalid/1"' },
      plugins: [{ name: 'capture-real-initializer', setup(bundler) {
        bundler.onResolve({ filter: /^(?:@sentry\/(?:browser|react)|capture-sdk)$/ }, () => ({ path: 'sdk', namespace: 'capture' }));
        bundler.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ contents: 'let options; export const init = value => { options = value; }; export const captured = () => options;' }));
        // Locale loading is unrelated to release metadata; retain the real
        // initializer, filtering and DOM evidence collection.
        bundler.onResolve({ filter: /^\.\/i18n$/ }, () => ({ path: 'locale', namespace: 'locale' }));
        bundler.onLoad({ filter: /.*/, namespace: 'locale' }, () => ({ contents: 'export const currentLanguageBase = () => "en";' }));
      } }],
    });
    initializers.push((await import(pathToFileURL(outfile).href)).default);
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

describe('Sentry build and event release contract', () => {
  it('bounds exception values before the real beforeSend filter runs', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { BrowserClient } from '@sentry/browser';
      import { Window } from 'happy-dom';
      const window = new Window({ url: 'https://worldmonitor.app/' });
      for (const key of ['window', 'document', 'location', 'navigator']) {
        Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true });
      }
      const options = await (await import(${JSON.stringify(pathToFileURL(join(scratch, 'dashboard-init.mjs')).href)})).default();
      const observed = [];
      const sent = [];
      const client = new BrowserClient({
        ...options, integrations: [], stackParser: () => [],
        beforeSend(event, hint) {
          observed.push(event.exception.values[0].value.length);
          return options.beforeSend(event, hint);
        },
        transport: () => ({ send: async envelope => { sent.push(envelope[1][0][1]); return { statusCode: 200 }; }, flush: async () => true }),
      });
      for (const value of [
        'Unexpected application error /assets/' + 'a-'.repeat(100000) + '!',
        'Ordinary application failure',
        'Failed to fetch dynamically imported module: https://worldmonitor.app/assets/main-AbC123.js',
      ]) {
        client.captureEvent({ exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: '/assets/main-AbC123.js', lineno: 1, function: 'run' }] } }] } });
        await client.flush(1000);
      }
      await client.close();
      await window.happyDOM.close();
      process.stdout.write(JSON.stringify({ observed, values: sent.map(event => event.exception.values[0].value) }));
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error?.code, undefined, 'SDK filtering must finish within five seconds');
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.observed[0], 2051, 'SDK truncation includes its three-character suffix');
    assert.equal(result.values.length, 2, 'the known owned chunk-load error is still filtered');
    assert.ok(result.values[0].startsWith('Unexpected application error /assets/'));
    assert.equal(result.values[1], 'Ordinary application failure');
  });

  for (const target of ['production', 'preview', 'development']) {
    it(`aligns both bundles and source-map uploads in ${target}`, async () => {
      process.env.SENTRY_AUTH_TOKEN = 'test-only-never-sent';
      process.env.VERCEL_GIT_COMMIT_SHA = sha;
      process.env.VERCEL_ENV = target;
      const configs = [
        await loadDashboard({ mode: 'production', command: 'build' }),
        (await import(`${marketingConfigUrl}?target=${target}`)).default,
      ];
      for (const [index, config] of configs.entries()) {
        assert.equal(JSON.parse(String(config.define?.__BUILD_HASH__)), sha);
        const upload = uploadOptions(config);
        assert.equal(upload.name, sha);
        assert.equal(upload.dist, sha);
        assert.equal(upload.inject, false);
        const publishes = index === 0 && target === 'production';
        assert.equal(upload.create, publishes);
        assert.equal(upload.finalize, publishes);
        assert.equal(upload.setCommits, publishes ? undefined : false);
        assert.equal(upload.deploy, publishes ? undefined : false);

        // A real SDK client produces the event envelope. Only delivery is
        // replaced; release, dist and scope tags pass through Sentry itself.
        const hostname = target === 'production' ? 'worldmonitor.app' : target === 'preview' ? 'worldmonitor-preview.vercel.app' : 'dev.example';
        const window = new Window({ url: `https://${hostname}/` });
        const globals = ['window', 'document', 'location', 'navigator'] as const;
        const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
        for (const key of globals) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true });
        let client: BrowserClient | undefined;
        try {
          const options = await initializers[index]();
          assert.equal(options.environment, target);
          assert.equal(options.enabled, true);
          const envelopes: Envelope[] = [];
          client = new BrowserClient({
            ...options,
            integrations: [], stackParser: () => [],
            transport: () => ({
              send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
              flush: async () => true,
            }),
          });
          const scope = new Scope();
          scope.update(typeof options.initialScope === 'function' ? options.initialScope(scope) : options.initialScope);
          for (const fingerprint of [undefined, ['custom-group']]) {
            client.captureEvent({ exception: { values: [{ type: 'Error', value: 'synthetic release contract check' }] }, fingerprint }, {}, scope);
            await client.flush(1000);
            const envelope = envelopes.pop();
            assert.ok(envelope);
            const event = envelope[1][0][1] as ErrorEvent;
            assert.equal(event.release, target === 'production' ? sha : undefined);
            assert.equal(event.dist, target === 'production' ? sha : undefined);
            assert.deepEqual(event.fingerprint, target === 'production' ? fingerprint : [...(fingerprint ?? ['{{ default }}']), `worldmonitor:${target}`]);
            assert.equal(event.tags?.app_version, JSON.parse(String(config.define?.__APP_VERSION__)));
            assert.equal(event.tags?.build_sha, sha);
          }
        } finally {
          await client?.close();
          for (const [i, key] of globals.entries()) {
            const descriptor = descriptors[i];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
          await window.happyDOM.close();
        }
      }
    });
  }

  it('does not publish a production release with a missing deployment SHA', async () => {
    process.env.SENTRY_AUTH_TOKEN = 'test-only-never-sent';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const config = await loadDashboard({ mode: 'production', command: 'build' });
    const upload = uploadOptions(config);
    assert.equal(upload.create, false);
    assert.equal(upload.finalize, false);
    assert.equal(upload.setCommits, false);
  });
});
