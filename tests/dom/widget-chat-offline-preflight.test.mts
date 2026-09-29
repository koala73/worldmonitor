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
  it('says the browser is offline instead of asking a Pro user to upgrade', async () => {
    setOnline(false);
    // Clerk cannot mint a token offline; a token-less request is what the
    // server answers with the "Pro subscription required" 403.
    vi.mocked(getClerkToken).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightOffline')));
    expect(readiness()).not.toBe(t('widgets.preflightProSubscriptionRequired'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not read a token-less 403 as a missing subscription for a signed-in user', async () => {
    setOnline(true);
    vi.mocked(getClerkToken).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightSessionUnavailable')));
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

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightOffline')));
  });

  it('re-runs the check when the connection returns', async () => {
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, proKeyConfigured: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    open();
    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightOffline')));

    online = true;
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightConnected')));
    expect(document.querySelector<HTMLButtonElement>('.widget-chat-send')!.disabled).toBe(false);
  });

  it('keeps the upgrade copy for a real entitlement 403', async () => {
    setOnline(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Pro subscription required' }), { status: 403 })));

    open();

    await vi.waitFor(() => expect(readiness()).toBe(t('widgets.preflightProSubscriptionRequired')));
  });
});
