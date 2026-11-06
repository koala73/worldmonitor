import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';

// SM-138: a 401 that lands while the client still holds a signed-in session is
// a token-refresh race (right after sign-in, or on wake from sleep), not a
// signed-out user. It must retry on the shared transient budget and re-check
// on the next auth/entitlement signal — never park a paying user on a
// terminal "Sign in" card until they hide and re-show the tab.

const auth = vi.hoisted(() => ({
  state: { user: null, isPending: false } as AuthSession,
  listeners: new Set<(state: AuthSession) => void>(),
}));
const keys = vi.hoisted(() => ({ testerKey: false }));
const ent = vi.hoisted(() => ({
  state: null as EntitlementState | null,
  listeners: new Set<(state: EntitlementState | null) => void>(),
}));

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => auth.state,
  subscribeAuthState: (cb: (state: AuthSession) => void) => {
    auth.listeners.add(cb);
    cb(auth.state);
    return () => { auth.listeners.delete(cb); };
  },
}));
vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  getEntitlementState: () => ent.state,
  onEntitlementChange: (cb: (state: EntitlementState | null) => void) => {
    ent.listeners.add(cb);
    if (ent.state !== null) cb(ent.state);
    return () => { ent.listeners.delete(cb); };
  },
}));
// A desktop/tester key unlocks the panel without binding a Clerk user — the
// one way a signed-out browser reaches the panel's own sign-in render.
vi.mock('@/services/widget-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/widget-store')>();
  return { ...actual, isProUser: () => keys.testerKey || actual.isProUser() };
});
vi.mock('@/services/clerk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/clerk')>()),
  getClerkToken: vi.fn(async () => 'test-token'),
  clearClerkTokenCache: vi.fn(),
}));

import { clearClerkTokenCache, getClerkToken } from '@/services/clerk';
import { LatestBriefPanel } from '@/components/LatestBriefPanel';

const PRO_USER = { id: 'user_pro', name: 'Pro', email: 'pro@example.test', role: 'pro' as const };
const PRO_ENTITLEMENT = {
  planKey: 'pro_monthly',
  features: { tier: 1 },
  validUntil: Date.now() + 86_400_000,
} as unknown as EntitlementState;

const READY_BODY = {
  status: 'ready',
  issueDate: '2026-11-06',
  dateLong: '6 November 2026',
  greeting: 'Good morning.',
  threadCount: 4,
  magazineUrl: 'https://www.worldmonitor.app/brief/test',
};

const unauthorized = (): Response => new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
});
const ready = (): Response => new Response(JSON.stringify(READY_BODY), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

/** Responses for /api/latest-brief, in order; `briefFallback` once drained. */
let briefResponses: Array<() => Response> = [];
let briefFallback: () => Response = ready;
let briefCalls = 0;
let panel: LatestBriefPanel | null = null;

function emitAuth(): void {
  for (const cb of [...auth.listeners]) cb(auth.state);
}
function emitEntitlement(): void {
  for (const cb of [...ent.listeners]) cb(ent.state);
}

function mount(): LatestBriefPanel {
  panel = new LatestBriefPanel();
  document.body.append(panel.getElement());
  panel.notifyConnected();
  return panel;
}

const text = (): string => panel?.getElement().textContent ?? '';
const SIGN_IN = 'Sign in to view your brief.';
const GIVE_UP = 'We couldn’t confirm your plan.';

beforeAll(initTestI18n);

beforeEach(() => {
  vi.useFakeTimers();
  auth.state = { user: PRO_USER, isPending: false };
  auth.listeners.clear();
  ent.state = PRO_ENTITLEMENT;
  ent.listeners.clear();
  keys.testerKey = false;
  briefResponses = [];
  briefFallback = ready;
  briefCalls = 0;
  vi.mocked(clearClerkTokenCache).mockClear();
  vi.mocked(getClerkToken).mockReset();
  vi.mocked(getClerkToken).mockImplementation(async () => 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The ready render lazily loads the referral profile; keep it out of the
    // brief-request count and let it fail quietly.
    if (!url.includes('/api/latest-brief')) return new Response('{}', { status: 404 });
    briefCalls += 1;
    return (briefResponses.shift() ?? briefFallback)();
  }));
});

afterEach(() => {
  panel?.destroy();
  panel = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('LatestBriefPanel — 401 while the client is signed in (SM-138)', () => {
  it('retries a transient 401 on its backoff and recovers without a visibility change', async () => {
    briefResponses = [unauthorized];
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));
    expect(text()).not.toContain(SIGN_IN);
    expect(briefCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(text()).toContain('Read brief'));
    expect(briefCalls).toBe(2);
    expect(document.visibilityState).toBe('visible');
  });

  it('drops the cached Clerk token so the retry mints a fresh one', async () => {
    briefResponses = [unauthorized];
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));
    expect(clearClerkTokenCache).toHaveBeenCalledTimes(1);
  });

  it('re-checks immediately when the auth state next changes for the same user', async () => {
    briefResponses = [unauthorized];
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));

    emitAuth(); // Clerk session/token refreshed — same user id.
    await vi.waitFor(() => expect(text()).toContain('Read brief'));
    expect(briefCalls).toBe(2);
  });

  it('re-checks immediately when an entitlement snapshot arrives', async () => {
    ent.state = null;
    briefResponses = [unauthorized];
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));

    ent.state = PRO_ENTITLEMENT;
    emitEntitlement();
    await vi.waitFor(() => expect(text()).toContain('Read brief'));
    expect(briefCalls).toBe(2);
  });

  it('ignores auth notifications its own token fetch causes — no backoff-free retry loop', async () => {
    // Minting a token can make Clerk notify listeners for the same user. That
    // notification is caused by our own retry, so it must not queue another.
    vi.mocked(getClerkToken).mockImplementation(async () => {
      emitAuth();
      return 'test-token';
    });
    briefFallback = unauthorized;
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));
    expect(briefCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(briefCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(briefCalls).toBe(3);
  });

  it('does not refetch on auth or entitlement signals once the brief has loaded', async () => {
    mount();
    await vi.waitFor(() => expect(text()).toContain('Read brief'));
    emitAuth();
    emitEntitlement();
    await vi.advanceTimersByTimeAsync(0);
    expect(briefCalls).toBe(1);
  });

  it('gives up with the existing terminal message once the transient budget is spent', async () => {
    briefFallback = unauthorized;
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));
    // Backoff 15 + 30 + 60 + 120 + 180 × 4 s covers the eight retries.
    await vi.advanceTimersByTimeAsync(1_000_000);
    await vi.waitFor(() => expect(text()).toContain(GIVE_UP));
    expect(briefCalls).toBe(9);
    expect(text()).not.toContain(SIGN_IN);
    // Terminal: no armed retry keeps polling.
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(briefCalls).toBe(9);
  });
});

describe('LatestBriefPanel — genuinely signed out (control)', () => {
  it('shows the sign-in card immediately and never fetches', async () => {
    auth.state = { user: null, isPending: false };
    keys.testerKey = true;
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(text()).toContain(SIGN_IN);
    expect(briefCalls).toBe(0);
  });

  it('shows the sign-in card at once when the user signs out after a 401', async () => {
    briefFallback = unauthorized;
    mount();
    await vi.waitFor(() => expect(text()).toContain('Reconnecting to your account'));

    auth.state = { user: null, isPending: false };
    emitAuth();
    expect(text()).toContain(SIGN_IN);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(text()).toContain(SIGN_IN);
    expect(briefCalls).toBe(1);
  });
});
