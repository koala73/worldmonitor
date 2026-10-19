// A signed-in Pro desktop reaches the cloud with the same Clerk bearer a Pro
// browser sends; a free or signed-out desktop forwards nothing (#9396).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entitled = vi.hoisted(() => ({
  value: false,
  state: null as unknown,
  // Like the real module, a known snapshot replays to a new subscriber at once.
  replay: undefined as unknown,
  listeners: new Set<(state: unknown) => void>(),
}));
const clerkToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('@/services/entitlements', () => ({
  isEntitled: () => entitled.value,
  getEntitlementState: () => entitled.state,
  onEntitlementChange: (listener: (state: unknown) => void) => {
    entitled.listeners.add(listener);
    if (entitled.replay !== undefined) listener(entitled.replay);
    return () => entitled.listeners.delete(listener);
  },
}));
vi.mock('@/services/clerk', () => ({ getClerkToken: clerkToken }));
type Session = { user: { id: string } | null; isPending: boolean };
const auth = vi.hoisted(() => ({
  session: { user: null, isPending: true } as { user: { id: string } | null; isPending: boolean },
  listeners: new Set<(session: { user: { id: string } | null; isPending: boolean }) => void>(),
}));
vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (listener: (session: Session) => void) => {
    auth.listeners.add(listener);
    listener(auth.session);
    return () => auth.listeners.delete(listener);
  },
}));

function emitEntitlement(next: boolean, state: unknown = { planKey: next ? 'pro' : 'free' }) {
  entitled.value = next;
  for (const listener of [...entitled.listeners]) listener(state);
}

function emitAuth(session: Session) {
  auth.session = session;
  for (const listener of [...auth.listeners]) listener(session);
}

const HINT_KEY = 'wm-desktop-cloud-access';

beforeEach(() => {
  vi.resetModules();
  entitled.value = false;
  entitled.state = null;
  entitled.replay = undefined;
  entitled.listeners.clear();
  auth.session = { user: null, isPending: true };
  auth.listeners.clear();
  clerkToken.mockReset();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('first launch wave on a desktop that had cloud access', () => {
  it('asks Clerk for the session token before any entitlement snapshot lands', async () => {
    localStorage.setItem(HINT_KEY, '1');
    clerkToken.mockResolvedValue('clerk-jwt');
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBe('Bearer clerk-jwt');
  });

  it('forwards nothing when Clerk has no session', async () => {
    localStorage.setItem(HINT_KEY, '1');
    clerkToken.mockResolvedValue(null);
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
  });

  it("lets this launch's free snapshot overrule the hint", async () => {
    localStorage.setItem(HINT_KEY, '1');
    entitled.state = { planKey: 'free' };
    clerkToken.mockResolvedValue('clerk-jwt');
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
    expect(clerkToken).not.toHaveBeenCalled();
  });

  it('gives up on a Clerk load that never settles', async () => {
    vi.useFakeTimers();
    localStorage.setItem(HINT_KEY, '1');
    clerkToken.mockReturnValue(new Promise(() => {}));
    const { getDesktopCloudAuthorization, DESKTOP_CLOUD_TOKEN_WAIT_MS } = await import('@/services/desktop-cloud-auth');
    const pending = getDesktopCloudAuthorization();
    await vi.advanceTimersByTimeAsync(DESKTOP_CLOUD_TOKEN_WAIT_MS);
    expect(await pending).toBeNull();
  });
});

describe('watchDesktopCloudAccess', () => {
  it('remembers cloud access across an auth handoff and forgets it on sign-out', async () => {
    const { watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    watchDesktopCloudAccess(() => {});
    emitEntitlement(true);
    expect(localStorage.getItem(HINT_KEY)).toBe('1');
    emitEntitlement(false, null);
    expect(localStorage.getItem(HINT_KEY)).toBe('1');
    emitAuth({ user: null, isPending: false });
    expect(localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it('forgets cloud access when the plan lapses to free', async () => {
    const { watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    watchDesktopCloudAccess(() => {});
    emitEntitlement(true);
    emitEntitlement(false);
    expect(localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it('reloads once when Pro arrives after a request already went out without it', async () => {
    const reload = vi.fn();
    const { getDesktopCloudAuthorization, watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    watchDesktopCloudAccess(reload);
    expect(await getDesktopCloudAuthorization()).toBeNull();
    clerkToken.mockResolvedValue('clerk-jwt');
    emitEntitlement(true);
    emitEntitlement(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once per session so a slow entitlement cannot loop', async () => {
    sessionStorage.setItem('wm-desktop-cloud-reloaded', '1');
    const reload = vi.fn();
    const { getDesktopCloudAuthorization, watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    watchDesktopCloudAccess(reload);
    await getDesktopCloudAuthorization();
    emitEntitlement(true);
    expect(reload).not.toHaveBeenCalled();
    sessionStorage.clear();
  });

  it('does not reload when the launch already sent the credential', async () => {
    localStorage.setItem(HINT_KEY, '1');
    clerkToken.mockResolvedValue('clerk-jwt');
    const reload = vi.fn();
    const { getDesktopCloudAuthorization, watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    watchDesktopCloudAccess(reload);
    expect(await getDesktopCloudAuthorization()).toBe('Bearer clerk-jwt');
    emitEntitlement(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('getDesktopCloudAuthorization', () => {
  it('returns the Clerk bearer for an entitled user', async () => {
    entitled.value = true;
    clerkToken.mockResolvedValue('clerk-jwt');
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBe('Bearer clerk-jwt');
  });

  it('forwards nothing for a free user without asking Clerk for a token', async () => {
    clerkToken.mockResolvedValue('clerk-jwt');
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
    expect(clerkToken).not.toHaveBeenCalled();
  });

  it('forwards nothing when an entitled user has no live session', async () => {
    entitled.value = true;
    clerkToken.mockResolvedValue(null);
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
  });

  it('forwards nothing when the token lookup fails', async () => {
    entitled.value = true;
    clerkToken.mockRejectedValue(new Error('clerk unavailable'));
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
  });
});

describe('proxyLocalApiRequest user credential', () => {
  const invoke = vi.fn(async (_cmd: string, _args: unknown) => ({ status: 200, headers: {}, body: [] }));
  beforeEach(() => {
    invoke.mockClear();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  });
  afterEach(() => vi.unstubAllGlobals());

  function sentHeaders(): Headers {
    const payload = invoke.mock.calls[0]?.[1] as { request: { headers: Record<string, string> } };
    return new Headers(payload.request.headers);
  }

  it('carries the user bearer under its own header and never as Authorization', async () => {
    const { proxyLocalApiRequest } = await import('@/services/tauri-bridge');
    await proxyLocalApiRequest('/api/bootstrap', 'http://localhost/api/bootstrap',
      { headers: { Authorization: 'Bearer premium-fetch-jwt' } }, 'Bearer clerk-jwt');
    expect(sentHeaders().get('x-worldmonitor-user-authorization')).toBe('Bearer clerk-jwt');
    expect(sentHeaders().get('authorization')).toBeNull();
  });

  it('drops a renderer-supplied user header when no credential is passed', async () => {
    const { proxyLocalApiRequest } = await import('@/services/tauri-bridge');
    await proxyLocalApiRequest('/api/bootstrap', 'http://localhost/api/bootstrap',
      { headers: { 'X-WorldMonitor-User-Authorization': 'Bearer forged' } });
    expect(sentHeaders().get('x-worldmonitor-user-authorization')).toBeNull();
  });
});

describe('desktop runtime fetch', () => {
  const proxy = vi.fn(async () => new Response('ok'));
  const cloudAuth = vi.fn<() => Promise<string | null>>();
  beforeEach(() => {
    proxy.mockClear();
    cloudAuth.mockReset();
    vi.doMock('@/services/tauri-bridge', () => ({ proxyLocalApiRequest: proxy }));
    vi.doMock('@/services/desktop-cloud-auth', () => ({ getDesktopCloudAuthorization: cloudAuth }));
    vi.stubGlobal('__TAURI_INTERNALS__', {});
  });
  afterEach(() => {
    vi.doUnmock('@/services/tauri-bridge');
    vi.doUnmock('@/services/desktop-cloud-auth');
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__wmFetchPatched;
  });

  it('passes the Pro credential to the sidecar proxy', async () => {
    cloudAuth.mockResolvedValue('Bearer clerk-jwt');
    (await import('@/services/runtime')).installRuntimeFetchPatch();
    await window.fetch('/api/bootstrap');
    expect(proxy).toHaveBeenCalledWith('/api/bootstrap', '/api/bootstrap', undefined, 'Bearer clerk-jwt');
  });

  it('never resolves a credential for local-only routes', async () => {
    cloudAuth.mockResolvedValue('Bearer clerk-jwt');
    (await import('@/services/runtime')).installRuntimeFetchPatch();
    await window.fetch('/api/local-status');
    expect(cloudAuth).not.toHaveBeenCalled();
    expect(proxy).toHaveBeenCalledWith('/api/local-status', '/api/local-status', undefined, undefined);
  });
});
