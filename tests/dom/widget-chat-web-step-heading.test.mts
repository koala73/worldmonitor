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

// Health answers ready; generation streams one progress step and stays open.
function stubAgent(endpoint: string): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('health')) return new Response(JSON.stringify({ ok: true, proKeyConfigured: true }), { status: 200 });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'tool_call', endpoint })}\n\n`));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }));
}

async function sendPrompt(): Promise<void> {
  openWidgetChatModal({ mode: 'create', tier: 'pro', onComplete: vi.fn() });
  await vi.waitFor(() => expect(document.querySelector('.widget-chat-readiness')?.textContent).toBe(t('widgets.preflightConnected')));
  const input = document.querySelector('.widget-chat-modal textarea, textarea') as HTMLTextAreaElement;
  input.value = 'Premier League table';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const send = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t('widgets.send'));
  send!.click();
}

const heading = () => document.querySelector('.widget-chat-preview-heading')?.textContent ?? '';

beforeAll(initTestI18n);
beforeEach(() => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.mocked(getAuthState).mockReturnValue(signedIn);
  vi.mocked(getClerkToken).mockResolvedValue('jwt');
});
afterEach(() => {
  closeWidgetChatModal();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Widget chat progress heading', () => {
  it('does not call a web page read "live WorldMonitor data"', async () => {
    stubAgent('read:www.goal.com');
    await sendPrompt();
    await vi.waitFor(() => expect(document.querySelector('.widget-chat-preview-copy')?.textContent).toBe('read:www.goal.com'));
    expect(heading()).not.toBe(t('widgets.previewFetchingHeading'));
  });

  it('does not call a web search or source check "live WorldMonitor data"', async () => {
    for (const endpoint of ['search:premier league table', 'verify:sources']) {
      stubAgent(endpoint);
      await sendPrompt();
      await vi.waitFor(() => expect(document.querySelector('.widget-chat-preview-copy')?.textContent).toBe(endpoint));
      expect(heading()).not.toBe(t('widgets.previewFetchingHeading'));
      closeWidgetChatModal();
      document.body.replaceChildren();
    }
  });

  it('keeps the WorldMonitor heading for WorldMonitor data', async () => {
    stubAgent('/api/bootstrap');
    await sendPrompt();
    await vi.waitFor(() => expect(document.querySelector('.widget-chat-preview-copy')?.textContent).toBe('/api/bootstrap'));
    expect(heading()).toBe(t('widgets.previewFetchingHeading'));
  });
});
