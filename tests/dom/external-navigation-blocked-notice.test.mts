/**
 * Sentry WORLDMONITOR-1ED: a caller that must not leave the page
 * (`sameTabFallback: false`) got `'failed'` back when the browser refused the
 * new tab, and the user saw nothing happen. Safari, a PlayStation 5 browser
 * and an Electron wrapper all reported it, from the GitHub star prompt and the
 * Cmd+K headline results.
 *
 * The page now offers the same URL as a real link. Clicking an anchor is a
 * fresh user navigation, which popup blockers allow, and the dashboard stays
 * where it is until the user chooses the link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: () => {} }));
vi.mock('@/services/i18n', () => ({
  t: (key: string, opts?: { host?: string }) => (opts?.host ? `${key}:${opts.host}` : key),
}));

import { openExternalUrl } from '@/services/external-navigation';

const ARTICLE = 'https://news.example.com/world/story?id=7';

let openResult: Window | null;
let assigned: string[];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await vi.dynamicImportSettled();
}

function notice(): HTMLElement | null {
  return document.querySelector('.toast-notification');
}

beforeEach(() => {
  openResult = null;
  assigned = [];
  vi.spyOn(window, 'open').mockImplementation(() => openResult);
  vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
    assigned.push(String(url));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('a blocked new tab for a caller that stays on the page', () => {
  it('offers the URL as a link instead of doing nothing', async () => {
    const outcome = await openExternalUrl(ARTICLE, null, { sameTabFallback: false });
    await settle();

    expect(outcome).toBe('failed');
    expect(assigned).toEqual([]);
    const el = notice();
    expect(el, 'a notice must appear').not.toBeNull();
    expect(el!.textContent).toContain('components.externalNavigation.blocked');
    const link = el!.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(ARTICLE);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')?.split(/\s+/)).toContain('noopener');
    expect(link!.textContent).toBe('components.externalNavigation.openLink:news.example.com');
  });

  it('names the site without a leading www', async () => {
    await openExternalUrl('https://www.github.com/koala73/worldmonitor', null, { sameTabFallback: false });
    await settle();
    expect(notice()?.querySelector('a')?.textContent).toBe('components.externalNavigation.openLink:github.com');
  });

  it('takes the notice down once the link is used', async () => {
    await openExternalUrl(ARTICLE, null, { sameTabFallback: false });
    await settle();
    const link = notice()!.querySelector('a')!;
    let connectedAtActivation: boolean | undefined;
    // Runs after the notice's own listener, where the browser would follow
    // the link: a disconnected anchor does not navigate.
    document.addEventListener('click', () => { connectedAtActivation = link.isConnected; });
    link.addEventListener('click', (e) => e.preventDefault());
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(connectedAtActivation).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(notice()).toBeNull();
  });

  it('leaves the link to the browser instead of the UTM interceptor', async () => {
    // The interceptor reroutes external `_blank` clicks through window.open,
    // which is the call that was just refused.
    const { installUtmInterceptor } = await import('@/utils/utm');
    installUtmInterceptor();
    await openExternalUrl(ARTICLE, null, { sameTabFallback: false });
    await settle();
    const link = notice()!.querySelector('a')!;
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    const opensBefore = vi.mocked(window.open).mock.calls.length;
    let prevented: boolean | undefined;
    // Record, then cancel: happy-dom would otherwise follow the link over the network.
    document.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(prevented).toBe(false);
    expect(vi.mocked(window.open).mock.calls.length).toBe(opensBefore);
  });

  it('keeps one notice when the user clicks again', async () => {
    await openExternalUrl(ARTICLE, null, { sameTabFallback: false });
    await openExternalUrl(ARTICLE, null, { sameTabFallback: false });
    await settle();
    expect(document.querySelectorAll('.toast-notification')).toHaveLength(1);
  });
});

describe('outcomes that need no notice', () => {
  it('shows nothing when the tab opened', async () => {
    openResult = { opener: null } as unknown as Window;
    expect(await openExternalUrl(ARTICLE, null, { sameTabFallback: false })).toBe('popup');
    await settle();
    expect(notice()).toBeNull();
  });

  it('shows nothing when the default same-tab fallback navigated', async () => {
    expect(await openExternalUrl(ARTICLE)).toBe('same-tab');
    await settle();
    expect(assigned).toEqual([ARTICLE]);
    expect(notice()).toBeNull();
  });

  it('never offers a URL the opener refused', async () => {
    expect(await openExternalUrl('javascript:alert(1)', null, { sameTabFallback: false })).toBe('failed');
    expect(await openExternalUrl('http://news.example.com/', null, { sameTabFallback: false })).toBe('failed');
    await settle();
    expect(notice()).toBeNull();
  });
});
