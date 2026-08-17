/**
 * #6779 — the desktop sidecar readiness probe must hit the sidecar's own
 * dependency-free liveness endpoint (/api/sidecar-health), not the generic
 * /api/service-status page, and must return an honest boolean the caller can act
 * on (App.ts logs when it's false instead of silently treating not-ready as ready).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

let desktop = true;
vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => desktop,
}));

const { waitForSidecarReady } = await import('@/services/runtime');

afterEach(() => {
  desktop = true;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('waitForSidecarReady (#6779)', () => {
  it('probes /api/sidecar-health (not /api/service-status) and returns true on 200', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ready = await waitForSidecarReady(1000);

    expect(ready).toBe(true);
    const probedUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(probedUrl).toContain('/api/sidecar-health');
    expect(probedUrl).not.toContain('/api/service-status');
  });

  it('returns false when the sidecar never answers within the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const ready = await waitForSidecarReady(400);

    expect(ready).toBe(false);
  });

  it('returns false off the desktop runtime (no local base URL to probe)', async () => {
    desktop = false;
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ready = await waitForSidecarReady(1000);

    expect(ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
