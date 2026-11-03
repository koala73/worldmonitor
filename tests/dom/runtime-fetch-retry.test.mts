import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/services/tauri-bridge', () => ({ proxyLocalApiRequest: proxy }));
vi.mock('@/services/clerk', () => ({ getClerkToken: async () => null }));

const API = 'https://api.worldmonitor.app';
const ORIGIN = 'https://worldmonitor.app';
const PATH = '/api/version';
const originalFetch = window.fetch;
const state = window as unknown as Record<string, unknown>;

type Form = 'relative' | 'absolute' | 'url' | 'request' | 'api-url' | 'api-request';
function inputFor(form: Form, method: string): [RequestInfo | URL, RequestInit?] {
  const init = { method, ...(method === 'POST' ? { body: 'payload' } : {}) };
  if (form === 'relative') return [PATH, init];
  if (form === 'absolute') return [API + PATH, init];
  if (form === 'url') return [new URL(ORIGIN + PATH), init];
  if (form === 'api-url') return [new URL(API + PATH), init];
  return [new Request((form === 'request' ? ORIGIN : API) + PATH, init)];
}

beforeEach(() => {
  vi.resetModules();
  proxy.mockReset();
  vi.stubEnv('VITE_WS_API_URL', API);
  vi.stubGlobal('location', { hostname: 'worldmonitor.app', host: 'worldmonitor.app', protocol: 'https:', origin: ORIGIN, href: ORIGIN + '/' });
});
afterEach(() => {
  window.fetch = originalFetch;
  delete state.__wmWebRedirectPatched;
  delete state.__wmFetchPatched;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function web(failure: number | 'network', abort?: AbortController) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    abort?.abort();
    if (failure === 'network') throw new TypeError('network failure');
    return new Response('failure', { status: failure });
  });
  window.fetch = fetch;
  (await import('@/services/runtime')).installWebApiRedirect();
  return fetch;
}

describe('web generic fallback', () => {
  for (const form of ['relative', 'absolute', 'url', 'request', 'api-url', 'api-request'] as const) {
    for (const failure of [404, 405, 501, 502, 503, 'network'] as const) {
      it(`does not replay POST ${form} after ${failure}`, async () => {
        const native = await web(failure);
        const [input, init] = inputFor(form, 'POST');
        const result = window.fetch(input, init);
        if (failure === 'network') await expect(result).rejects.toThrow('network failure');
        else expect((await result).status).toBe(failure);
        expect(native).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const method of ['GET', 'HEAD']) {
    for (const form of ['relative', 'absolute', 'url', 'request'] as const) {
      it(`retains ${method} ${form} recovery`, async () => {
        const native = await web(502);
        native.mockResolvedValueOnce(new Response(null, { status: 502 })).mockResolvedValueOnce(new Response(null, { status: 200 }));
        expect((await window.fetch(...inputFor(form, method))).status).toBe(200);
        expect(native).toHaveBeenCalledTimes(2);
      });
    }
  }
  for (const form of ['relative', 'request'] as const) {
    for (const failure of [502, 'network'] as const) {
      it(`does not recover cancelled ${form} after ${failure}`, async () => {
        const controller = new AbortController();
        const native = await web(failure, controller);
        const input = form === 'request' ? new Request(ORIGIN + PATH, { signal: controller.signal }) : PATH;
        await window.fetch(input, form === 'relative' ? { signal: controller.signal } : undefined).catch(() => {});
        expect(native).toHaveBeenCalledTimes(1);
      });
    }
  }
  it('uses init method over Request method', async () => {
    const native = await web(502);
    await window.fetch(new Request(ORIGIN + PATH), { method: 'PATCH', body: 'change' });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('allows an effective GET overriding a bodyless POST Request', async () => {
    const native = await web(502);
    await window.fetch(new Request(ORIGIN + PATH, { method: 'POST' }), { method: 'GET' });
    expect(native).toHaveBeenCalledTimes(2);
  });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`does not replay ${method} on a rejected fetch`, async () => {
      const native = await web('network');
      await expect(window.fetch(PATH, { method })).rejects.toThrow('network failure');
      expect(native).toHaveBeenCalledTimes(1);
    });
  }
  it('preserves caller credentials and headers through safe recovery', async () => {
    const native = await web(502);
    await window.fetch(PATH, { credentials: 'omit', headers: { 'X-Test': 'retained' } });
    expect(native).toHaveBeenCalledTimes(2);
    for (const [, init] of native.mock.calls) {
      expect(init?.credentials).toBe('omit');
      expect(new Headers(init?.headers).get('X-Test')).toBe('retained');
    }
  });
  it('retains explicit billing denial retry for POST', async () => {
    vi.useFakeTimers();
    const native = await web(503);
    native.mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'X-Billing-Verification': 'entitlement_verification_unavailable', 'Retry-After': '1' } })).mockResolvedValueOnce(new Response('ok'));
    const request = window.fetch(PATH, { method: 'POST', body: 'payload' });
    await vi.runAllTimersAsync();
    expect((await request).status).toBe(200);
    expect(native).toHaveBeenCalledTimes(2);
    expect(native.mock.calls.map(call => String(call[0]))).toEqual([API + PATH, API + PATH]);
  });
});

describe('desktop generic recovery', () => {
  for (const form of ['relative', 'url', 'request'] as const) {
    for (const failure of [502, 'network'] as const) {
      it(`does not replay POST ${form} after ${failure}`, async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', {});
        const native = vi.fn(async () => new Response('cloud'));
        window.fetch = native;
        if (failure === 'network') proxy.mockRejectedValue(new Error('native failure'));
        else proxy.mockResolvedValue(new Response('failure', { status: failure }));
        (await import('@/services/runtime')).installRuntimeFetchPatch();
        const request = window.fetch(...inputFor(form, 'POST'));
        if (failure === 'network') await expect(request).rejects.toThrow('native failure');
        else expect((await request).status).toBe(failure);
        expect(proxy).toHaveBeenCalledTimes(1);
        expect(native).not.toHaveBeenCalled();
      });
    }
  }
  it('preserves Request headers and signal on safe cloud fallback', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const native = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('cloud'));
    window.fetch = native;
    proxy.mockResolvedValue(new Response('failure', { status: 502 }));
    (await import('@/services/runtime')).installRuntimeFetchPatch();
    const controller = new AbortController();
    const request = new Request(ORIGIN + PATH, { headers: { 'X-Test': 'retained' }, signal: controller.signal });
    expect((await window.fetch(request)).status).toBe(200);
    const forwarded = native.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    if (!(forwarded instanceof Request)) throw new Error('Expected a Request');
    expect(forwarded.headers.get('X-Test')).toBe('retained');
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });
  it('does not retry or send to cloud when cancelled during startup backoff', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const native = vi.fn(async () => new Response('cloud'));
    window.fetch = native;
    proxy.mockRejectedValue(new Error('native failure'));
    (await import('@/services/runtime')).installRuntimeFetchPatch();
    const controller = new AbortController();
    const result = window.fetch(PATH, { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });
});
