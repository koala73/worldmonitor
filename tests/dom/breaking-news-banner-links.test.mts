import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/breaking-news-alerts', () => ({
  getAlertSettings: () => ({
    enabled: true,
    soundEnabled: false,
    desktopNotificationsEnabled: false,
    sensitivity: 'critical-and-high',
  }),
}));

vi.mock('@/config/feeds', () => ({
  getSourcePanelId: () => 'news',
}));

vi.mock('@/components/news/source-provenance', () => ({
  renderPrimarySourceProvenance: () => ({ riskBadge: '', tierBadge: '' }),
}));

vi.mock('@/services/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('@/utils', () => ({
  isMobileDevice: () => false,
}));

import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import type { BreakingAlert } from '@/services/breaking-news-alerts';

function emitAlert(overrides: Partial<BreakingAlert> = {}): BreakingAlert {
  const alert: BreakingAlert = {
    id: 'alert-1',
    headline: 'A breaking story',
    source: 'Reuters',
    threatLevel: 'critical',
    timestamp: new Date(),
    origin: 'rss_alert',
    ...overrides,
  };

  document.dispatchEvent(new CustomEvent<BreakingAlert>('wm:breaking-news', { detail: alert }));
  return alert;
}

describe('breaking-news banner source links', () => {
  let banner: BreakingNewsBanner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', class {
      public volume = 0;
      public currentTime = 0;
      public play = vi.fn().mockResolvedValue(undefined);
    });
    document.body.replaceChildren();
    banner = new BreakingNewsBanner();
  });

  afterEach(() => {
    banner.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exposes an assertive live region before any alert is injected', () => {
    const container = document.querySelector('.breaking-news-container');
    expect(container).not.toBeNull();
    expect(container?.getAttribute('role')).toBe('log');
    expect(container?.getAttribute('aria-live')).toBe('assertive');
    expect(container?.getAttribute('aria-label')).toBe('components.breakingNews.alertsRegion');
    expect(container?.querySelector('.breaking-alert')).toBeNull();
  });

  it('reveals the target panel from the dedicated view-panel button', () => {
    emitAlert({ link: 'https://example.com/breaking-story' });
    const revealPanel = vi.fn();
    window.addEventListener('wm:reveal-panel', revealPanel);

    document.querySelector<HTMLButtonElement>('.breaking-alert-view-panel')!.click();

    expect(revealPanel).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { panelId: 'news' } }),
    );
    window.removeEventListener('wm:reveal-panel', revealPanel);
  });

  it('renders a safe article URL as the headline link', () => {
    emitAlert({ link: 'https://example.com/breaking-story?edition=world&source=wire' });

    const link = document.querySelector<HTMLAnchorElement>('a.breaking-alert-headline');
    expect(link?.textContent).toBe('A breaking story');
    expect(link?.href).toBe('https://example.com/breaking-story?edition=world&source=wire');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
  });

  it('keeps alerts without a URL as text and rejects unsafe URLs', () => {
    emitAlert();
    emitAlert({ id: 'alert-2', link: 'javascript:alert(1)' });

    expect(document.querySelectorAll('a.breaking-alert-headline')).toHaveLength(0);
    expect(document.querySelectorAll('span.breaking-alert-headline')).toHaveLength(2);
  });

  it('opens the headline independently while the rest of the row still reveals its panel', () => {
    emitAlert({ link: 'https://example.com/breaking-story' });
    const revealPanel = vi.fn();
    window.addEventListener('wm:reveal-panel', revealPanel, { once: true });

    const link = document.querySelector<HTMLAnchorElement>('a.breaking-alert-headline');
    expect(link).not.toBeNull();
    link!.addEventListener('click', event => event.preventDefault());
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(revealPanel).not.toHaveBeenCalled();

    document.querySelector<HTMLElement>('.breaking-alert')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(revealPanel).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { panelId: 'news' } }),
    );
  });

  it('still dismisses the alert without revealing its panel', () => {
    emitAlert({ link: 'https://example.com/breaking-story' });
    const revealPanel = vi.fn();
    window.addEventListener('wm:reveal-panel', revealPanel, { once: true });

    document.querySelector<HTMLButtonElement>('.breaking-alert-dismiss')!.click();

    expect(document.querySelector('.breaking-alert')).toBeNull();
    expect(revealPanel).not.toHaveBeenCalled();
    window.removeEventListener('wm:reveal-panel', revealPanel);
  });
});
