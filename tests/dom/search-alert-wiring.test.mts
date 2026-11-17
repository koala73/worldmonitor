/**
 * The Cmd+K "Alerts sent to you" wiring (src/app/search-alert-wiring.ts):
 * where a selected alert's article opens, and when the indexed alerts are
 * dropped. The source, the modal and the server each have their own suite;
 * this one covers what only the wiring decides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => runtime.desktop,
}));

// The native side of `open_url`. The real external-navigation module runs.
const invokeTauri = vi.hoisted(() => vi.fn());
vi.mock('@/services/tauri-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tauri-bridge')>()),
  invokeTauri: (...args: unknown[]) => invokeTauri(...args),
}));
vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: vi.fn() }));

import { canOpenSentAlertLink, openSentAlertLink } from '@/app/search-alert-wiring';

const HTTPS_LINK = 'https://www.reuters.com/world/hormuz';
const HTTP_LINK = 'http://example.org/story';

let windowOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runtime.desktop = false;
  invokeTauri.mockReset().mockResolvedValue(undefined);
  windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  windowOpen.mockRestore();
});

describe('opening a selected alert', () => {
  it('hands the article to the OS browser on desktop, never to the app WebView', async () => {
    runtime.desktop = true;
    openSentAlertLink(HTTPS_LINK);
    await vi.waitFor(() => expect(invokeTauri).toHaveBeenCalledWith('open_url', { url: HTTPS_LINK }));
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('opens a new tab on the web, with no opener and no referrer', () => {
    openSentAlertLink(HTTPS_LINK);
    expect(windowOpen).toHaveBeenCalledWith(HTTPS_LINK, '_blank', 'noopener,noreferrer');
    expect(invokeTauri).not.toHaveBeenCalled();
  });

  it('offers a plain-http article on the web, where a tab can open it', () => {
    expect(canOpenSentAlertLink(HTTP_LINK)).toBe(true);
    expect(canOpenSentAlertLink(HTTPS_LINK)).toBe(true);
  });

  it('offers only what the native opener accepts on desktop', () => {
    runtime.desktop = true;
    expect(canOpenSentAlertLink(HTTPS_LINK)).toBe(true);
    // The native opener refuses plain http, so the row must not offer it.
    expect(canOpenSentAlertLink(HTTP_LINK)).toBe(false);
  });

  it('never offers a link that is not http or https', () => {
    for (const desktop of [false, true]) {
      runtime.desktop = desktop;
      for (const link of ['', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
        expect(canOpenSentAlertLink(link), `${desktop ? 'desktop' : 'web'}: ${link}`).toBe(false);
      }
    }
  });
});
