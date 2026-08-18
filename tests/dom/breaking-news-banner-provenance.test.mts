import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isMobile } = vi.hoisted(() => ({ isMobile: vi.fn(() => false) }));

vi.mock('@/services/breaking-news-alerts', () => ({
  getAlertSettings: () => ({
    enabled: true,
    soundEnabled: false,
    desktopNotificationsEnabled: false,
    sensitivity: 'critical-and-high',
  }),
}));

vi.mock('@/services/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('@/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils')>();
  return {
    ...actual,
    isMobileDevice: () => isMobile(),
  };
});

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

function mountBanner(): BreakingNewsBanner {
  return new BreakingNewsBanner();
}

describe('breaking-news banner source provenance (#6598)', () => {
  let banner: BreakingNewsBanner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', class {
      public volume = 0;
      public currentTime = 0;
      public play = vi.fn().mockResolvedValue(undefined);
    });
    document.body.replaceChildren();
    isMobile.mockReturnValue(false);
  });

  afterEach(() => {
    banner?.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('desktop overlay', () => {
    beforeEach(() => {
      banner = mountBanner();
    });

    it('mounts as a body-level overlay', () => {
      const container = document.querySelector('.breaking-news-container');
      expect(container).not.toBeNull();
      expect(container?.parentElement).toBe(document.body);
    });

    it('renders the same Reuters tier badge as the news list (green, no propaganda badge)', () => {
      emitAlert({ source: 'Reuters' });

      const meta = document.querySelector('.breaking-alert-meta');
      const tier = meta?.querySelector('.tier-badge.tier-1');
      expect(tier).not.toBeNull();
      expect(tier?.textContent).toBe('★ Wire');
      expect(tier?.getAttribute('title')).toMatch(/Wire Service/i);
      expect(meta?.querySelector('.propaganda-badge')).toBeNull();
      expect(meta?.querySelector('.breaking-alert-source')?.textContent).toBe('Reuters');
    });

    it('renders Al Jazeera as a blue tier-2 badge plus amber caution badge', () => {
      emitAlert({ source: 'Al Jazeera' });

      const meta = document.querySelector('.breaking-alert-meta');
      const tier = meta?.querySelector('.tier-badge.tier-2');
      const risk = meta?.querySelector('.propaganda-badge.medium');
      expect(tier).not.toBeNull();
      expect(tier?.textContent).toBe('●');
      expect(risk).not.toBeNull();
      expect(risk?.textContent).toMatch(/Caution/);
    });

    it('renders MIIT as a green tier-1 badge plus the red official-government badge', () => {
      emitAlert({ source: 'MIIT (China)' });

      const meta = document.querySelector('.breaking-alert-meta');
      const tier = meta?.querySelector('.tier-badge.tier-1');
      const risk = meta?.querySelector('.propaganda-badge.high');
      expect(tier).not.toBeNull();
      expect(tier?.textContent).toBe('★');
      expect(tier?.textContent).not.toMatch(/Wire/);
      expect(risk).not.toBeNull();
      expect(risk?.textContent).toBe('Official Government Source');
    });

    it('surfaces unreviewed provenance as the grey unknown badge', () => {
      emitAlert({ source: 'Completely Unlisted Outlet XYZ' });

      const risk = document.querySelector('.breaking-alert-meta .propaganda-badge.unknown');
      expect(risk).not.toBeNull();
      expect(risk?.textContent).toMatch(/\? Unreviewed/);
    });
  });

  describe('mobile in-flow', () => {
    beforeEach(() => {
      isMobile.mockReturnValue(true);
      const app = document.createElement('div');
      app.id = 'app';
      const header = document.createElement('header');
      header.className = 'header';
      const mainContent = document.createElement('main');
      mainContent.className = 'main-content';
      app.append(header, mainContent);
      document.body.appendChild(app);
      banner = mountBanner();
    });

    it('joins the document flow after the header instead of overlaying the body', () => {
      const app = document.querySelector('#app');
      const header = document.querySelector('.header');
      const mainContent = document.querySelector('.main-content');
      const container = document.querySelector('.breaking-news-container');
      expect(container).not.toBeNull();
      expect(header?.nextElementSibling).toBe(container);
      expect(container?.nextElementSibling).toBe(mainContent);
      expect(container?.parentElement).toBe(app);
    });

    it('keeps provenance and tier badges in the in-flow alert', () => {
      emitAlert({ source: 'MIIT (China)', id: 'mobile-miit' });

      const alertEl = document.querySelector('.breaking-alert');
      expect(alertEl?.closest('.breaking-news-container')).not.toBeNull();
      expect(alertEl?.querySelector('.tier-badge.tier-1')).not.toBeNull();
      expect(alertEl?.querySelector('.propaganda-badge.high')).not.toBeNull();
      expect(alertEl?.querySelector('.breaking-alert-source')?.textContent).toBe('MIIT (China)');
    });
  });
});
