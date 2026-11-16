// The Vite dev server must not serve api/*.js source for an /api/* request no
// dev handler takes. It used to: the app got JavaScript where it expected JSON,
// and transforming that source made the dependency optimizer discover
// server-only packages mid-session and reload, which blanked other open pages
// in e2e runs (bootstrap-request-budget's map harness, run 43809584635).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Vite dev server /api source guard', () => {
  let server: ViteDevServer;
  let origin: string;

  before(async () => {
    server = await createServer({
      root,
      configFile: resolve(root, 'vite.config.ts'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await server?.close();
  });

  for (const path of ['/api/bootstrap', '/api/telegram-feed', '/api/health?compact=1', '/api/bootstrap.js']) {
    it(`answers ${path} with a JSON 404, not api/ source`, async () => {
      const response = await fetch(origin + path);
      const body = await response.text();
      assert.equal(response.status, 404, body.slice(0, 120));
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.doesNotMatch(body, /\bimport\b/);
    });
  }

  it('still serves browser modules and leaves unknown /api paths to the next handler', async () => {
    const module = await fetch(`${origin}/src/main.ts`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type') ?? '', /javascript/);
    const unknown = await fetch(`${origin}/api/no-such-endpoint-for-guard-test`);
    assert.doesNotMatch(unknown.headers.get('content-type') ?? '', /javascript/);
  });
});
