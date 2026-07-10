import { devices, expect, test, type Page } from '@playwright/test';

type PaintEntrySnapshot = {
  name: string;
  startTime: number;
};

type LcpEntrySnapshot = {
  className: string;
  inShell: boolean;
  size: number;
  startTime: number;
  text: string;
};

const { defaultBrowserType: mobileDefaultBrowserType, ...mobileDevice } = devices['iPhone 14 Pro Max'];
void mobileDefaultBrowserType;

const SHELL_LCP_TEXT = 'Dashboard is loading';

declare global {
  interface Window {
    __wmPaintEntries?: PaintEntrySnapshot[];
    __wmLcpEntries?: LcpEntrySnapshot[];
  }
}

const installPaintObservers = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    window.__wmPaintEntries = [];
    window.__wmLcpEntries = [];

    try {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__wmPaintEntries?.push({
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      });
      paintObserver.observe({ type: 'paint', buffered: true });
    } catch {
      // Older engines without paint timing still exercise the DOM candidate below.
    }

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const lcp = entry as PerformanceEntry & {
            element?: Element;
            size?: number;
          };
          window.__wmLcpEntries?.push({
            className: typeof lcp.element?.className === 'string' ? lcp.element.className : '',
            inShell: Boolean(lcp.element?.closest('.skeleton-shell')),
            size: lcp.size ?? 0,
            startTime: lcp.startTime,
            text: lcp.element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? '',
          });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // WebKit/older engines may not expose LCP, so FCP + visible candidate is the hard gate.
    }
  });
};

const delayDashboardMain = async (page: Page): Promise<{ release: () => void; requested: Promise<void> }> => {
  let releaseMain!: () => void;
  let resolveRequested!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });

  await page.route('**/src/main.ts', async (route) => {
    resolveRequested();
    await releasePromise;
    await route.continue();
  });

  return { release: releaseMain, requested };
};

test.describe('pre-hydration dashboard shell', () => {
  test.beforeEach(async ({ page }) => {
    await installPaintObservers(page);
  });

  test('paints contentful HTML before the dashboard bundle hydrates', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-shell')).toBeVisible();
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      await expect.poll(async () => page.evaluate(() => (
        performance.getEntriesByName('first-contentful-paint').length
          + (window.__wmPaintEntries ?? []).filter((entry) => entry.name === 'first-contentful-paint').length
      )), {
        message: 'first-contentful-paint should fire while the dashboard module is still blocked',
        timeout: 5000,
      }).toBeGreaterThan(0);

      await expect.poll(async () => page.evaluate(() => {
        if (document.documentElement.classList.contains('wm-layout-hydrated')) return -1;
        return (window.__wmLcpEntries ?? []).filter((entry) => (
          entry.inShell
          && entry.size > 0
          && entry.className.includes('skeleton-')
          && entry.text.length > 0
        )).length;
      }), {
        message: 'largest-contentful-paint should be the server-delivered shell before hydration',
        timeout: 5000,
      }).toBeGreaterThan(0);

      const preHydration = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.skeleton-shell');
        const candidate = document.querySelector<HTMLElement>('.skeleton-lcp-copy');
        const appHeading = document.querySelector<HTMLElement>('body > h1.app-heading');
        const badgeGroup = document.querySelector<HTMLElement>('.skeleton-map-badges');
        if (!shell || !candidate) {
          throw new Error('missing pre-hydration shell content');
        }

        const rect = candidate.getBoundingClientRect();
        const styles = getComputedStyle(candidate);
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        const focusable = shell.querySelectorAll(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
        );

        return {
          ariaBusy: shell.getAttribute('aria-busy'),
          ariaHidden: shell.getAttribute('aria-hidden'),
          appHeadingAriaHidden: appHeading?.getAttribute('aria-hidden') ?? null,
          appHeadingText: appHeading?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          appHeadingTag: appHeading?.tagName ?? '',
          badgeAriaLabel: badgeGroup?.getAttribute('aria-label') ?? null,
          candidateRect: {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          },
          candidateText: candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          display: styles.display,
          fcpStart: fcp?.startTime ?? null,
          focusableCount: focusable.length,
          hydrated: document.documentElement.classList.contains('wm-layout-hydrated'),
          lcpEntries: window.__wmLcpEntries ?? [],
          opacity: Number(styles.opacity),
          shellText: shell.innerText.replace(/\s+/g, ' ').trim(),
          visibility: styles.visibility,
        };
      });

      expect(preHydration.hydrated).toBe(false);
      expect(preHydration.ariaHidden).toBeNull();
      expect(preHydration.ariaBusy).toBe('true');
      expect(preHydration.appHeadingTag).toBe('H1');
      expect(preHydration.appHeadingAriaHidden).toBeNull();
      expect(preHydration.appHeadingText).toContain('World Monitor');
      expect(preHydration.badgeAriaLabel).toBeNull();
      expect(preHydration.focusableCount).toBe(0);
      expect(preHydration.shellText).toContain('World Monitor');
      expect(preHydration.shellText).toContain(SHELL_LCP_TEXT);
      expect(preHydration.shellText).toContain('Primary View');
      expect(preHydration.candidateText).toBe(SHELL_LCP_TEXT);
      expect(preHydration.candidateRect.width).toBeGreaterThan(260);
      expect(preHydration.candidateRect.height).toBeGreaterThan(18);
      expect(preHydration.display).not.toBe('none');
      expect(preHydration.visibility).toBe('visible');
      expect(preHydration.opacity).toBeGreaterThan(0.9);
      expect(preHydration.fcpStart).not.toBeNull();

      const latestLcp = preHydration.lcpEntries.at(-1);
      expect(latestLcp, JSON.stringify(preHydration.lcpEntries)).toBeTruthy();
      expect(latestLcp!.inShell, JSON.stringify(preHydration.lcpEntries)).toBe(true);
      expect(latestLcp!.className).toContain('skeleton-');
      expect(latestLcp!.size).toBeGreaterThan(0);
      expect(latestLcp!.text.length).toBeGreaterThan(0);

      releaseMain();

      await expect(page.locator('.header')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      await expect(page.locator('body > h1.app-heading')).toContainText('World Monitor');
      await expect.poll(async () => page.evaluate(() => (
        document.documentElement.classList.contains('wm-layout-hydrated')
      ))).toBe(true);
      expect(pageErrors.filter((message) => /hydration|skeleton|layout/i.test(message))).toHaveLength(0);
    } finally {
      releaseMain();
    }
  });
});

test.describe('pre-hydration dashboard shell on mobile', () => {
  test.use({
    ...mobileDevice,
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2.625,
  });

  test.beforeEach(async ({ page }) => {
    await installPaintObservers(page);
  });

  test('keeps the contentful shell inside the mobile viewport before hydration', async ({ page }) => {
    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-shell')).toBeVisible();
      await expect(page.locator('.skeleton-map-title')).toBeVisible();
      await expect(page.locator('[data-shell-lcp]')).toHaveText(SHELL_LCP_TEXT);

      await expect.poll(async () => page.evaluate(() => (
        performance.getEntriesByName('first-contentful-paint').length
          + (window.__wmPaintEntries ?? []).filter((entry) => entry.name === 'first-contentful-paint').length
      )), {
        message: 'mobile first-contentful-paint should fire while the dashboard module is still blocked',
        timeout: 5000,
      }).toBeGreaterThan(0);

      const mobileShell = await page.evaluate(() => {
        const title = document.querySelector('.skeleton-map-title');
        const panel = document.querySelector('.skeleton-panel');
        const titleRect = title?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        return {
          hydrated: document.documentElement.classList.contains('wm-layout-hydrated'),
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          titleRect: titleRect ? {
            bottom: titleRect.bottom,
            height: titleRect.height,
            left: titleRect.left,
            right: titleRect.right,
            top: titleRect.top,
            width: titleRect.width,
          } : null,
          panelRect: panelRect ? {
            bottom: panelRect.bottom,
            height: panelRect.height,
            left: panelRect.left,
            right: panelRect.right,
            top: panelRect.top,
            width: panelRect.width,
          } : null,
        };
      });

      expect(mobileShell.hydrated).toBe(false);
      expect(mobileShell.scrollWidth).toBeLessThanOrEqual(mobileShell.innerWidth + 1);
      expect(mobileShell.titleRect).not.toBeNull();
      expect(mobileShell.titleRect!.left).toBeGreaterThanOrEqual(0);
      expect(mobileShell.titleRect!.right).toBeLessThanOrEqual(mobileShell.innerWidth);
      expect(mobileShell.titleRect!.height).toBeGreaterThan(20);
      expect(mobileShell.panelRect).not.toBeNull();
      expect(mobileShell.panelRect!.left).toBeGreaterThanOrEqual(0);
      expect(mobileShell.panelRect!.right).toBeLessThanOrEqual(mobileShell.innerWidth);

      releaseMain();

      await expect(page.locator('.header')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
    } finally {
      releaseMain();
    }
  });

  test('matches the persisted collapsed-map footprint through hydration', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mobile-map-collapsed', 'true');
    });
    const delayedMain = await delayDashboardMain(page);
    let released = false;
    const releaseMain = () => {
      if (released) return;
      released = true;
      delayedMain.release();
    };

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await delayedMain.requested;
      await expect(page.locator('.skeleton-map')).toBeVisible();
      await expect(page.locator('.skeleton-map-body')).toBeHidden();

      const shellHeight = await page.locator('.skeleton-map').evaluate((element) => element.getBoundingClientRect().height);
      expect(shellHeight).toBeGreaterThan(0);

      releaseMain();

      await expect(page.locator('#mapSection.collapsed')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.skeleton-shell')).toHaveCount(0);
      const hydratedHeight = await page.locator('#mapSection').evaluate((element) => element.getBoundingClientRect().height);

      expect(Math.abs(hydratedHeight - shellHeight), 'collapsed map footprint drift').toBeLessThanOrEqual(2);
      await expect.poll(async () => page.evaluate(() => (
        document.documentElement.classList.contains('wm-map-collapsed')
      ))).toBe(false);
    } finally {
      releaseMain();
    }
  });
});

test.describe('dashboard shell without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('hides the JS-only shell and keeps the no-JS content scrollable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.skeleton-shell')).toBeHidden();
    await expect(page.locator('body > h1.app-heading')).toBeHidden();
    await expect(page.locator('#seo-prerender')).toBeVisible();
    await expect(page.locator('body')).toContainText('World Monitor Pro');

    const beforeScroll = await page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      docOverflow: getComputedStyle(document.documentElement).overflow,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      y: window.scrollY,
    }));

    expect(beforeScroll.bodyOverflow).not.toBe('hidden');
    expect(beforeScroll.docOverflow).not.toBe('hidden');
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.viewportHeight);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const afterScrollY = await page.evaluate(() => window.scrollY);

    expect(afterScrollY).toBeGreaterThan(beforeScroll.y);
  });
});
