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
  { apiBase, hostname, protocol = 'http:' }:
    { apiBase?: string; hostname: string; protocol?: 'http:' | 'https:' },
): Promise<typeof import('@/services/runtime')> {
  vi.resetModules();
  vi.stubEnv('VITE_WS_API_URL', apiBase ?? '');
  // protocol/host matter: the desktop detector treats an https loopback origin
  // as "might be Tauri", so the guard has to see the real scheme.
  vi.stubGlobal('location', {
    hostname,
    host: hostname,
    protocol,
    href: `${protocol}//${hostname}/`,
    origin: `${protocol}//${hostname}`,
  });
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

  for (const hostname of ['127.0.0.1', 'localhost']) {
    it(`ignores a remote configured base on https://${hostname} too`, async () => {
      // `detectDesktopRuntime` counts a bare https loopback origin as desktop,
      // because a Tauri window can serve from one before its bridge globals
      // appear. A dev server run over HTTPS must not inherit that exemption.
      const runtime = await loadRuntimeWith({
        apiBase: REMOTE_API,
        hostname,
        protocol: 'https:',
      });

      expect(runtime.getConfiguredWebApiBaseUrl()).toBe('');
    });
  }

  it('keeps the exemption for a real desktop shell on a loopback origin', async () => {
    // The positive control for the tightening above: an unambiguous Tauri
    // signal still opts out, so the shell keeps its cloud API base.
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const runtime = await loadRuntimeWith({
      apiBase: REMOTE_API,
      hostname: 'localhost',
      protocol: 'https:',
    });

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe(REMOTE_API);
  });

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

function loopbackHost(hostname: string, port: number): string {
  const bracketed = hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname;
  return `${bracketed}:${port}`;
}

function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('installWebApiRedirect on numeric loopback bases', () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__wmWebRedirectPatched;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  for (const hostname of ['127.0.0.1', '::1'] as const) {
    const pageOrigin = `http://${loopbackHost(hostname, 5173)}`;
    const configuredBase = `http://${loopbackHost(hostname, 8787)}`;

    for (const inputKind of ['relative string', 'URL', 'Request'] as const) {
      it(`redirects a ${inputKind} /api/ call to ${configuredBase}`, async () => {
        const seen: string[] = [];
        window.fetch = (async (input: RequestInfo | URL) => {
          seen.push(hrefOf(input));
          return new Response('ok', { status: 200 });
        }) as typeof fetch;

        const runtime = await loadRuntimeWith({
          apiBase: configuredBase,
          hostname,
        });
        Object.assign(window.location, {
          hostname,
          host: loopbackHost(hostname, 5173),
          protocol: 'http:',
          href: `${pageOrigin}/`,
          origin: pageOrigin,
        });

        expect(runtime.getConfiguredWebApiBaseUrl()).toBe(configuredBase);

        runtime.installWebApiRedirect();

        const path = '/api/llm-health';
        if (inputKind === 'relative string') {
          await window.fetch(path);
        } else if (inputKind === 'URL') {
          await window.fetch(new URL(path, pageOrigin));
        } else {
          await window.fetch(new Request(new URL(path, pageOrigin)));
        }

        expect(seen, 'installed dispatch must reach native fetch').not.toHaveLength(0);
        expect(seen[0]).toBe(`${configuredBase}${path}`);
      });
    }
  }
});

describe('HTTPS loopback uses the web API path, not the sidecar', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('installs the web wrapper and fetches same-origin, not 127.0.0.1:46123', async () => {
    // The getter-only tests above are not enough: startup still used to pick
    // the sidecar transport via `isDesktopRuntime()`, so `toApiUrl` and the
    // installed fetch wrapper could point at the local API while the getter
    // already returned the empty web base.
    const runtime = await loadRuntimeWith({
      apiBase: REMOTE_API,
      hostname: 'localhost',
      protocol: 'https:',
    });
    const win = window as unknown as Record<string, unknown>;
    delete win.__wmFetchPatched;
    delete win.__wmWebRedirectPatched;

    const fetchTargets: string[] = [];
    window.fetch = (async (input: RequestInfo | URL) => {
      fetchTargets.push(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    runtime.installRuntimeFetchPatch();
    runtime.installWebApiRedirect();

    expect(runtime.getConfiguredWebApiBaseUrl()).toBe('');
    expect(runtime.getApiBaseUrl()).toBe('');
    expect(runtime.toApiUrl('/api/bootstrap')).toBe('/api/bootstrap');
    expect(win.__wmFetchPatched).toBeUndefined();
    expect(win.__wmWebRedirectPatched).toBe(true);

    await window.fetch('/api/bootstrap');

    expect(fetchTargets).toEqual(['/api/bootstrap']);
    expect(fetchTargets.some((url) => url.includes('127.0.0.1:46123'))).toBe(false);
  });

  it('still selects the sidecar path for an unambiguous desktop shell', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const runtime = await loadRuntimeWith({
      apiBase: REMOTE_API,
      hostname: 'localhost',
      protocol: 'https:',
    });
    const win = window as unknown as Record<string, unknown>;
    delete win.__wmFetchPatched;
    delete win.__wmWebRedirectPatched;

    runtime.installRuntimeFetchPatch();
    runtime.installWebApiRedirect();

    expect(runtime.toApiUrl('/api/bootstrap')).toBe('http://127.0.0.1:46123/api/bootstrap');
    expect(win.__wmFetchPatched).toBe(true);
    expect(win.__wmWebRedirectPatched).toBeUndefined();
  });
});
