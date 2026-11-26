import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/after-paint', () => ({
  scheduleAfterFirstPaint: (fn: () => void) => fn(),
}));

import { initAnalytics, rememberLandingUtm, resetAnalyticsForTesting } from '@/services/analytics';

type BeforeSend = (type: string, payload: Record<string, unknown>) => Record<string, unknown>;

function hook(): BeforeSend {
  return (window as unknown as Record<string, BeforeSend>).__wmUmamiBeforeSend!;
}

describe('Umami first-touch utm re-attach', () => {
  beforeEach(() => {
    // happy-dom cannot load the remote tracker; only the installed hook matters.
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => node);
    resetAnalyticsForTesting();
    history.replaceState({}, '', '/dashboard?utm_source=chatgpt.com&lat=1&lon=2');
    // Same order as main.ts: capture, then the map URL sync strips utm.
    rememberLandingUtm(window.location.search);
    history.replaceState({}, '', '/dashboard?lat=1&lon=2');
    initAnalytics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAnalyticsForTesting();
    history.replaceState({}, '', '/');
  });

  it('re-attaches utm_source to the first pageview after the URL sync stripped it', () => {
    const out = hook()('event', { url: '/dashboard?lat=1&lon=2', website: 'w' });
    expect(out.url).toBe('/dashboard?lat=1&lon=2&utm_source=chatgpt.com');
  });

  it('keeps an absolute url absolute', () => {
    const out = hook()('event', { url: `${window.location.origin}/dashboard?lat=1` });
    expect(out.url).toBe(`${window.location.origin}/dashboard?lat=1&utm_source=chatgpt.com`);
  });

  it('does not re-attach on a second pageview', () => {
    hook()('event', { url: '/dashboard?lat=1' });
    const out = hook()('event', { url: '/dashboard?lat=3' });
    expect(out.url).toBe('/dashboard?lat=3');
  });

  it('does not re-attach on a custom event, and does not consume the pageview', () => {
    const custom = hook()('event', { url: '/dashboard?lat=1', name: 'panel-view' });
    expect(custom.url).toBe('/dashboard?lat=1');
    const pageview = hook()('event', { url: '/dashboard?lat=1' });
    expect(pageview.url).toContain('utm_source=chatgpt.com');
  });

  it('does not override a payload that already carries utm_source', () => {
    const out = hook()('event', { url: '/dashboard?utm_source=other' });
    expect(out.url).toBe('/dashboard?utm_source=other');
  });

  it('still removes sensitive params while attaching', () => {
    const out = hook()('event', {
      url: '/dashboard?wm_checkout_ref=R1&wm_checkout_account=a1&wm_checkout_discount=D1&lat=1',
      referrer: 'https://x.test/?token=t',
    });
    const params = new URL(String(out.url), window.location.origin).searchParams;
    expect(params.get('utm_source')).toBe('chatgpt.com');
    for (const k of ['wm_checkout_ref', 'wm_checkout_account', 'wm_checkout_discount']) expect(params.has(k)).toBe(false);
    expect(String(out.referrer)).not.toContain('token');
  });

  it('caps stored values at 100 characters', () => {
    resetAnalyticsForTesting();
    rememberLandingUtm(`?utm_source=${'a'.repeat(300)}`);
    initAnalytics();
    const out = hook()('event', { url: '/dashboard' });
    expect(new URL(String(out.url), window.location.origin).searchParams.get('utm_source')).toHaveLength(100);
  });
});
