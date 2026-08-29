/**
 * A loopback page must not redirect /api/ to a remote API origin.
 *
 * `api/_cors.js` and `server/cors.ts` both drop bare `localhost` / `127.0.0.1`
 * from the allow-list when NODE_ENV is production — deliberately, with a
 * comment saying so. So a browser on http://127.0.0.1:<port> that sends its
 * /api/ traffic to https://api.worldmonitor.app gets 403 on every call and
 * renders an empty dashboard.
 *
 * That is exactly what `VITE_WS_API_URL=https://api.worldmonitor.app` in a
 * developer's .env.local does to `npm run dev`, because the configured base was
 * applied before any origin check. The same value is legitimate for the
 * production build, the Tauri desktop shell (whose tauri:// and asset://
 * origins ARE allow-listed), and the self-hosted image — whose nginx proxies
 * /api/ server-side anyway (docker/nginx.conf.template).
 *
 * The rule under test: honour a configured base everywhere except when the page
 * itself is on loopback and the base is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REMOTE_API = 'https://api.worldmonitor.app';

async function loadRuntimeWith(
  { apiBase, hostname }: { apiBase?: string; hostname: string },
): Promise<typeof import('@/services/runtime')> {
  vi.resetModules();
  vi.stubEnv('VITE_WS_API_URL', apiBase ?? '');
  vi.stubGlobal('location', { hostname, href: `http://${hostname}/`, origin: `http://${hostname}` });
  return import('@/services/runtime');
}

describe('getConfiguredWebApiBaseUrl on a loopback page', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  for (const hostname of ['127.0.0.1', 'localhost']) {
    it(`ignores a remote configured base on ${hostname} so /api/ stays same-origin`, async () => {
      const runtime = await loadRuntimeWith({ apiBase: REMOTE_API, hostname });

      expect(runtime.getConfiguredWebApiBaseUrl()).toBe('');
    });
  }

  it('still honours a loopback configured base, so a local API on another port works', async () => {
    const runtime = await loadRuntimeWith({
      apiBase: 'http://127.0.0.1:8787',
      hostname: '127.0.0.1',
    });

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe('http://127.0.0.1:8787');
  });

  it('leaves a deployed WorldMonitor page pointed at the configured base', async () => {
    const runtime = await loadRuntimeWith({
      apiBase: REMOTE_API,
      hostname: 'www.worldmonitor.app',
    });

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe(REMOTE_API);
  });

  it('leaves a self-hosted page pointed at the configured base', async () => {
    // docker/Dockerfile bakes VITE_WS_API_URL and the image is served from an
    // arbitrary host. Suppressing there would break self-hosting.
    const runtime = await loadRuntimeWith({
      apiBase: REMOTE_API,
      hostname: 'monitor.example.org',
    });

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe(REMOTE_API);
  });

  it('keeps returning nothing on loopback when no base is configured', async () => {
    const runtime = await loadRuntimeWith({ hostname: '127.0.0.1' });

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe('');
  });
});
