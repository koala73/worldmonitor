import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/clerk', () => ({ getClerkToken: vi.fn() }));
vi.mock('@/services/auth-state', () => ({ getAuthState: vi.fn() }));
vi.mock('@/services/analytics', () => ({ track: vi.fn() }));
vi.mock('@/services/entitlement-desync-telemetry', () => ({ reportEntitlementDesync: vi.fn() }));

import { getClerkToken } from '@/services/clerk';
import { getAuthState } from '@/services/auth-state';
import { t } from '@/services/i18n';
import { closeWidgetChatModal, openWidgetChatModal } from '@/components/WidgetChatModal';

const signedIn = { user: { id: 'user_1', role: 'pro' }, isPending: false } as unknown as ReturnType<typeof getAuthState>;

function setOnline(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

function readiness(): string {
  return document.querySelector('.widget-chat-readiness')?.textContent ?? '';
}

function open(): void {
  openWidgetChatModal({ mode: 'create', tier: 'pro', onComplete: vi.fn() });
}

beforeAll(initTestI18n);
beforeEach(() => {
  vi.mocked(getAuthState).mockReturnValue(signedIn);
  vi.mocked(getClerkToken).mockResolvedValue('jwt');
});
afterEach(() => {
  closeWidgetChatModal();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Widget chat preflight without a network', () => {
  it('does not send a closed request after its token resolves into a new request', async () => {
    setOnline(true);
    let releaseToken!: (token: string) => void;
    vi.mocked(getClerkToken)
      .mockResolvedValueOnce('jwt') // First preflight.
      .mockImplementationOnce(() => new Promise(resolve => { releaseToken = resolve; }))
      .mockResolvedValue('jwt');
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      if (init?.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true, proKeyConfigured: true })));
      posts.push(String(init.body));
      return new Promise<Response>(() => {});
    }));
    const send = (prompt: string) => {
      document.querySelector<HTMLTextAreaElement>('.widget-chat-input')!.value = prompt;
      document.querySelector<HTMLButtonElement>('.widget-chat-send')!.click();
    };
    open();
    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')));
    send('Retired prompt');
    await vi.waitFor(() => expect(releaseToken).toBeTypeOf('function'));
    closeWidgetChatModal();
    open();
    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')));
    send('Current prompt');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    releaseToken('late-jwt');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!).prompt).toBe('Current prompt');
    expect(document.querySelector<HTMLButtonElement>('.widget-chat-send')!.disabled).toBe(true);
  });

  it('keeps a reopened request deadline when the closed request settles late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setOnline(true);
      let rejectOld!: (error: Error) => void;
      const postSignals: AbortSignal[] = [];
      vi.stubGlobal('fetch', vi.fn((_url, init) => {
        if (init?.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true, proKeyConfigured: true })));
        postSignals.push(init.signal);
        if (postSignals.length === 1) return new Promise<Response>((_resolve, reject) => { rejectOld = reject; });
        return new Promise<Response>(() => {});
      }));
      const send = () => {
        document.querySelector<HTMLTextAreaElement>('.widget-chat-input')!.value = 'Test widget';
        document.querySelector<HTMLButtonElement>('.widget-chat-send')!.click();
      };
      open();
      await vi.advanceTimersByTimeAsync(0);
      send();
      await vi.advanceTimersByTimeAsync(0);
      closeWidgetChatModal();
      open();
      await vi.advanceTimersByTimeAsync(0);
      send();
      await vi.advanceTimersByTimeAsync(0);
      expect(postSignals).toHaveLength(2);
      rejectOld(new DOMException('Closed', 'AbortError'));
      await vi.advanceTimersByTimeAsync(200_000);
      expect(postSignals[1]!.aborted).toBe(true);
      expect(document.querySelector('.widget-chat-footer-status')!.textContent).toBe(t('widgets.requestTimedOut'));
    } finally {
      closeWidgetChatModal();
      vi.useRealTimers();
    }
  });

  it('says the browser is offline instead of asking a Pro user to upgrade', async () => {
    setOnline(false);
    // Clerk cannot mint a token offline; a token-less request is what the
    // server answers with the "Pro subscription required" 403.
    vi.mocked(getClerkToken).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('connectivity.offlineUnavailable')));
    expect(readiness()).not.toBe(t('widgets.preflightProSubscriptionRequired'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not read a token-less 403 as a missing subscription for a signed-in user', async () => {
    setOnline(true);
    vi.mocked(getClerkToken).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightUnavailable')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports offline when the health request fails and the browser went offline', async () => {
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    vi.stubGlobal('fetch', vi.fn(async () => {
      online = false;
      throw new TypeError('Failed to fetch');
    }));

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('connectivity.offlineUnavailable')));
  });

  it('re-runs the check when the connection returns', async () => {
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, proKeyConfigured: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    open();
    await vi.waitFor(() => expect(readiness()).toBe(t('connectivity.offlineUnavailable')));

    online = true;
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')));
    expect(document.querySelector<HTMLButtonElement>('.widget-chat-send')!.disabled).toBe(false);
  });

  it('does not let a superseded preflight overwrite a newer result', async () => {
    setOnline(true);
    let releaseFirst!: (token: string | null) => void;
    vi.mocked(getClerkToken)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue('jwt');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, proKeyConfigured: true }), { status: 200 })));

    open();
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')));

    releaseFirst(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readiness()).toBe(t('widgets.preflightConnected'));
    expect(document.querySelector<HTMLButtonElement>('.widget-chat-send')!.disabled).toBe(false);
  });

  it('retries a missing token while the browser stays online', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setOnline(true);
      vi.mocked(getClerkToken).mockResolvedValueOnce(null).mockResolvedValue('jwt');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, proKeyConfigured: true }), { status: 200 })));

      open();
      await vi.advanceTimersByTimeAsync(0);
      expect(readiness()).toBe(t('widgets.preflightUnavailable'));

      await vi.advanceTimersByTimeAsync(15_000);
      expect(readiness()).toBe(t('widgets.preflightConnected'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once the modal is closed mid-check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setOnline(true);
      let releaseToken!: (token: string | null) => void;
      vi.mocked(getClerkToken)
        .mockImplementationOnce(() => new Promise((resolve) => { releaseToken = resolve; }))
        .mockResolvedValue(null);
      vi.stubGlobal('fetch', vi.fn());

      open();
      await vi.advanceTimersByTimeAsync(0);
      closeWidgetChatModal();
      const callsAtClose = vi.mocked(getClerkToken).mock.calls.length;
      releaseToken(null);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(vi.mocked(getClerkToken).mock.calls.length).toBe(callsAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the upgrade copy for a real entitlement 403', async () => {
    setOnline(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Pro subscription required' }), { status: 403 })));

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightProSubscriptionRequired')));
  });
});

it('does not report ready when the health body stalls past the deadline', async () => {
  setOnline(true);
  // Headers arrive with 200, then the body read hits the deadline.
  const stalled = {
    ok: true,
    status: 200,
    json: () => Promise.reject(new DOMException('deadline', 'TimeoutError')),
  } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async () => stalled));

  open();

  await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightUnavailable')));
  expect(document.querySelector<HTMLButtonElement>('.widget-chat-send')!.disabled).toBe(true);
});

it('recovers a timed-out health check with a bounded retry', async () => {
  setOnline(true);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'))
    .mockResolvedValue(Response.json({ ok: true, proKeyConfigured: true }));
  vi.stubGlobal('fetch', fetchMock);
  open();
  await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')), { timeout: 2000 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
