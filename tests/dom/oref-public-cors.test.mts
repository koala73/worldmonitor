import { afterEach, expect, it, vi } from 'vitest';

const originalFetch = window.fetch;

afterEach(() => {
  window.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__wmWebRedirectPatched;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('omits credentials for public OREF reads through the real API router', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_WS_API_URL', 'https://api.worldmonitor.app');
  vi.stubGlobal('location', {
    hostname: 'www.worldmonitor.app', host: 'www.worldmonitor.app',
    protocol: 'https:', origin: 'https://www.worldmonitor.app',
    href: 'https://www.worldmonitor.app/dashboard',
  });
  const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), credentials: init?.credentials });
    return new Response(JSON.stringify({
      configured: true, alerts: [], history: [], historyCount24h: 0,
      timestamp: '2026-09-20T00:00:00Z',
    }), { headers: { 'Access-Control-Allow-Origin': '*' } });
  }) as typeof fetch;

  const { installWebApiRedirect } = await import('@/services/runtime');
  installWebApiRedirect();
  const { fetchOrefAlerts, fetchOrefHistory } = await import('@/services/oref-alerts');
  expect((await fetchOrefAlerts()).configured).toBe(true);
  expect((await fetchOrefHistory()).configured).toBe(true);
  expect(requests).toEqual([
    { url: 'https://api.worldmonitor.app/api/oref-alerts', credentials: 'omit' },
    { url: 'https://api.worldmonitor.app/api/oref-alerts?endpoint=history', credentials: 'omit' },
  ]);
});
