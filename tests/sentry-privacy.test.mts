import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.env.WM_SENTRY_PRIVACY_PROBE;

if (mode) {
  const win = new Window({ url: 'https://worldmonitor.app/pro?token=SYNTH_PAGE#SYNTH_HASH' });
  Object.defineProperty(win.document, 'referrer', { value: 'https://example.test/from?code=SYNTH_REF#SYNTH_REF_HASH' });
  for (const key of ['document', 'location', 'navigator', 'history'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: win[key] });
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  const marketing = mode === 'marketing';
  const entry = marketing ? 'pro-test/src/sentry.ts' : 'src/bootstrap/sentry-init.ts';
  const source = await readFile(resolve(root, entry), 'utf8');
  const captured: { options?: Record<string, unknown> } = {};
  Reflect.set(globalThis, '__capturePrivacyOptions', (options: Record<string, unknown>) => { captured.options = options; });
  const result = await build({
    stdin: { contents: source + (marketing ? '' : '\nexport { buildSentryInitOptions };'), resolveDir: dirname(resolve(root, entry)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
    define: { 'import.meta.env': JSON.stringify({ VITE_SENTRY_DSN: 'https://123abc@example.test/1' }), __APP_VERSION__: '"2.10.0"', __BUILD_HASH__: '"synthetic-build"' },
    plugins: [{ name: 'capture-marketing-options', setup(builder) {
      builder.onResolve({ filter: /^@sentry\/react$/ }, () => ({ path: 'sentry-capture', namespace: 'capture' }));
      builder.onResolve({ filter: /^\.\/i18n$/ }, () => ({ path: 'language', namespace: 'capture' }));
      builder.onLoad({ filter: /.*/, namespace: 'capture' }, args => ({ contents: args.path === 'language'
        ? 'export const currentLanguageBase = () => "en";'
        : 'export const init = options => globalThis.__capturePrivacyOptions(options);', loader: 'js' }));
    } }],
  });
  const folder = resolve(root, 'node_modules/.cache');
  await mkdir(folder, { recursive: true });
  const bundle = resolve(folder, `privacy-${process.pid}.mjs`);
  await writeFile(bundle, result.outputFiles[0]!.text);
  const module = await import(pathToFileURL(bundle).href);
  if (marketing) module.initSentry();
  else captured.options = module.buildSentryInitOptions();
  await rm(bundle);
  assert.ok(captured.options);
  const sdkPath = marketing && process.env.WM_SENTRY_MARKETING_SDK === '1' ? resolve(root, 'pro-test/node_modules/@sentry/browser/build/npm/esm/dev/index.js')
    : resolve(root, 'node_modules/@sentry/browser/build/npm/esm/dev/index.js');
  const sdk = await import(pathToFileURL(sdkPath).href);
  const envelopes: unknown[] = [];
  sdk.init({ ...captured.options, tracesSampleRate: 1, transport: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
  sdk.addBreadcrumb({ category: 'navigation', data: { from: '/pro?code=SYNTH_FROM#hash', to: 'https://user:SYNTH_PASS@example.test/pro?token=SYNTH_TO#hash' } });
  sdk.addBreadcrumb({ category: 'fetch', data: { url: 'https://example.test/api?key=SYNTH_FETCH#fragment', method: 'GET', status_code: 503 } });
  sdk.addBreadcrumb({ category: 'console', message: 'Request failed https://example.test/api?token=SYNTH_CONSOLE', data: { arguments: [{ url: '/api?token=SYNTH_NESTED', authorization: 'SYNTH_AUTH' }] } });
  sdk.setUser({ id: 'SYNTH_USER', email: 'SYNTH_EMAIL', ip_address: '192.0.2.42' });
  sdk.captureEvent({
    exception: { values: [{ type: 'Error', value: 'Owned error https://example.test/api?token=SYNTH_MESSAGE', stacktrace: { frames: [{ filename: 'https://worldmonitor.app/assets/main-ABC123.js?token=SYNTH_FRAME', lineno: 12, function: 'ownedOperation' }] } }] },
    tags: { kind: 'checkout_request_failed' },
    extra: { accessToken: 'SYNTH_ACCESS_TOKEN', refreshToken: 'SYNTH_REFRESH_TOKEN', client_secret: 'SYNTH_CLIENT_SECRET', diagnosticUrl: '//example.test/api?token=SYNTH_EXTRA#fragment', relative: { url: 'api/test?token=SYNTH_RELATIVE' }, message: 'GET /api?token=SYNTH_RELATIVE_TEXT' },
    request: { headers: { 'X-Api-Key': 'SYNTH_API_KEY', Authorization: 'SYNTH_REQUEST_AUTH', Cookie: 'SYNTH_COOKIE' }, query_string: 'token=SYNTH_QUERY' },
  });
  sdk.captureEvent({ type: 'transaction', transaction: '/pro?code=SYNTH_TRANSACTION', start_timestamp: Date.now() / 1000 - 1, timestamp: Date.now() / 1000,
    contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
    spans: [{ trace_id: 'a'.repeat(32), span_id: 'c'.repeat(16), start_timestamp: Date.now() / 1000 - 1, timestamp: Date.now() / 1000,
      description: 'GET https://example.test/api?token=SYNTH_SPAN', data: { 'url.full': 'https://example.test/api?token=SYNTH_SPAN_DATA' } }],
  });
  sdk.startSpan({ name: 'GET https://example.test/api?token=SYNTH_LIVE_SPAN', forceTransaction: true }, (span: { setAttribute(key: string, value: string): void }) => {
    span.setAttribute('url.full', 'https://example.test/api?token=SYNTH_LIVE_SPAN_DATA');
    span.setAttribute('http.query', '?token=SYNTH_HTTP_QUERY');
    span.setAttribute('http.fragment', '#SYNTH_HTTP_FRAGMENT');
  });
  sdk.setUser(null);
  sdk.startSession();
  sdk.captureSession();
  await sdk.flush(2000);
  process.stdout.write(JSON.stringify(envelopes));
  await sdk.close(2000);
  await win.happyDOM.close();
} else {
  for (const surface of ['dashboard', 'marketing']) {
    test(`${surface} real SDK envelopes minimize URL and identity data and retain owned errors`, async () => {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
        cwd: root, env: { ...process.env, WM_SENTRY_PRIVACY_PROBE: surface }, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(child.status, 0, child.stderr);
      const envelopes = JSON.parse(child.stdout);
      const items = envelopes.flatMap((envelope: unknown[]) => envelope[1]);
      const error = items.find((item: [{ type: string }, unknown]) => item[0].type === 'event')?.[1];
      assert.ok(error, 'owned error must reach transport');
      assert.equal(error.tags.kind, 'checkout_request_failed');
      assert.equal(error.exception.values[0].type, 'Error');
      assert.equal(error.exception.values[0].stacktrace.frames[0].filename, 'https://worldmonitor.app/assets/main-ABC123.js');
      assert.equal(error.request.url, 'https://worldmonitor.app/pro');
      assert.equal(error.request.headers.Referer, 'https://example.test/from');
      assert.equal(error.sdk.settings.infer_ip, 'never');
      const liveSpan = items.find((item: [{ type: string }, { transaction?: string }]) => item[0].type === 'transaction' && item[1].transaction === 'GET https://example.test/api')?.[1];
      assert.ok(liveSpan, 'SDK-created span reaches transport');
      assert.equal(liveSpan.contexts.trace.data['http.query'], '[Filtered]');
      assert.equal(liveSpan.contexts.trace.data['http.fragment'], '[Filtered]');
      const sessions = items.filter((item: [{ type: string }]) => item[0].type === 'session');
      assert.ok(sessions.length, 'session reaches transport');
      for (const [, session] of sessions) assert.equal(session.attrs.ip_address, undefined);
      assert.doesNotMatch(JSON.stringify(envelopes), /SYNTH_|192\.0\.2\.42/);
    });
  }
}
