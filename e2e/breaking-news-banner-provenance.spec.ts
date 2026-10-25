import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { captureScreenshot } from './capture-screenshot';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

type HarnessWindow = Window & {
  __breakingNewsBannerHarness?: {
    ready: boolean;
    layout: 'overlay' | 'in-flow';
  };
};

function expectPngScreenshot(buffer: Buffer, label: string): void {
  expect(buffer.byteLength, `${label} screenshot should not be empty`).toBeGreaterThan(1_000);
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    expect(buffer[i], `${label} screenshot byte ${i} should match PNG magic`).toBe(PNG_MAGIC[i]);
  }
}

async function loadHarness(
  page: Page,
  viewport: { width: number; height: number },
  theme: 'dark' | 'light' = 'dark',
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/breaking-news-banner-harness.html');
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const w = window as HarnessWindow;
        return Boolean(w.__breakingNewsBannerHarness?.ready);
      });
    }, { timeout: 45_000 })
    .toBe(true);
  await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
}

async function harnessLayout(page: Page): Promise<'overlay' | 'in-flow' | null> {
  return await page.evaluate(() => {
    const w = window as HarnessWindow;
    return w.__breakingNewsBannerHarness?.layout ?? null;
  });
}

async function assertBadgeColourSemantics(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const banner = page.locator('.breaking-news-container');
  await expect(banner.locator('.breaking-alert')).toHaveCount(3);

  const reuters = banner.locator('.breaking-alert', { hasText: 'Reuters' });
  await expect(reuters.locator('.tier-badge.tier-1')).toHaveText('★ Wire');
  await expect(reuters.locator('.propaganda-badge')).toHaveCount(0);
  await expect(reuters.locator('.tier-badge.tier-1')).toHaveCSS('color', theme === 'dark' ? 'rgb(68, 255, 136)' : 'rgb(22, 101, 52)');
  await expect(banner.locator('.breaking-alert-time').first()).toHaveText('· just now');

  const alJazeera = banner.locator('.breaking-alert', { hasText: 'Al Jazeera' });
  await expect(alJazeera.locator('.tier-badge.tier-2')).toBeVisible();
  await expect(alJazeera.locator('.propaganda-badge.medium')).toContainText('Caution');
  await expect(alJazeera.locator('.propaganda-badge.medium')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 170, 0)' : 'rgb(133, 77, 14)');

  const miit = banner.locator('.breaking-alert', { hasText: 'MIIT (China)' });
  await expect(miit.locator('.tier-badge.tier-1')).toHaveText('★');
  await expect(miit.locator('.propaganda-badge.high')).toHaveText('Official Government Source: China');
  await expect(miit.locator('.propaganda-badge.high')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 68, 68)' : 'rgb(153, 27, 27)');

  for (const alert of await banner.locator('.breaking-alert').all()) {
    await expect(alert).toHaveCSS('background-image', 'none');
    const headline = await alert.locator('.breaking-alert-headline').boundingBox();
    const meta = await alert.locator('.breaking-alert-meta').boundingBox();
    expect(meta!.y).toBeGreaterThanOrEqual(headline!.y + headline!.height);
    for (const badge of await alert.locator('.tier-badge, .propaganda-badge').all()) {
      expect(await badge.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
  }
  const accessibility = await new AxeBuilder({ page })
    .include('.breaking-news-container')
    .withRules(['color-contrast'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test.describe('breaking news banner provenance screenshots', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`desktop overlay keeps readable provenance in ${theme} theme`, async ({ page }, testInfo) => {
      await loadHarness(page, { width: 1280, height: 720 }, theme);
      expect(await harnessLayout(page)).toBe('overlay');

      const banner = page.locator('.breaking-news-container');
      await expect(banner).toBeVisible();
      await assertBadgeColourSemantics(page, theme);

      const position = await banner.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe('fixed');

      const overflowX = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflowX).toBeLessThanOrEqual(1);

      await expect(banner).toHaveScreenshot(`desktop-overlay${theme === 'light' ? '-light' : ''}.png`, {
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        maxDiffPixelRatio: 0.04,
      });
      const screenshot = await captureScreenshot(page, testInfo, `desktop-overlay-${theme}`, {
        locator: banner,
      });
      expect(screenshot).toBeTruthy();
      expectPngScreenshot(await page.screenshot({ fullPage: false, animations: 'disabled' }), 'desktop');
    });

    test(`mobile in-flow keeps readable provenance in ${theme} theme without overflow`, async ({ page }, testInfo) => {
      await loadHarness(page, { width: 390, height: 844 }, theme);
      expect(await harnessLayout(page)).toBe('in-flow');

      const banner = page.locator('.breaking-news-container');
      await expect(banner).toBeVisible();
      await assertBadgeColourSemantics(page, theme);

      const metrics = await banner.evaluate((el) => {
        const style = getComputedStyle(el);
        const header = document.querySelector('.header');
        const mainContent = document.querySelector('.main-content');
        const bannerRect = el.getBoundingClientRect();
        const contentRect = mainContent?.getBoundingClientRect();
        return {
          position: style.position,
          afterHeader: header?.nextElementSibling === el,
          insideApp: el.parentElement?.id === 'app',
          contentAfterBanner: contentRect ? contentRect.top >= bannerRect.bottom - 1 : false,
          overflowX: el.scrollWidth - el.clientWidth,
        };
      });
      expect(metrics.position).toBe('static');
      expect(metrics.afterHeader).toBe(true);
      expect(metrics.insideApp).toBe(true);
      expect(metrics.contentAfterBanner).toBe(true);
      expect(metrics.overflowX).toBeLessThanOrEqual(1);

      const pageOverflowX = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflowX).toBeLessThanOrEqual(1);

      const appShell = page.locator('#app');
      await expect(appShell).toHaveScreenshot(`mobile-in-flow${theme === 'light' ? '-light' : ''}.png`, {
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        maxDiffPixelRatio: 0.04,
      });
      const screenshot = await captureScreenshot(page, testInfo, `mobile-in-flow-${theme}`, {
        locator: appShell,
      });
      expect(screenshot).toBeTruthy();
      expectPngScreenshot(await page.screenshot({ fullPage: false, animations: 'disabled' }), 'mobile');
    });
  }

  test('long headline and source disclosure fit a narrow mobile screen', async ({ page }, testInfo) => {
    await loadHarness(page, { width: 320, height: 780 }, 'light');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: {
      id: 'long-headline',
      headline: 'Trump waives new Russia sanctions as Ukraine ties slump amid a longer diplomatic update',
      source: 'France 24',
      threatLevel: 'high',
      timestamp: new Date(),
      origin: 'rss_alert',
      link: 'https://example.com/france24',
      corroboration: { state: 'single-publisher', publishers: 1 },
    } })));
    const alert = page.locator('[data-alert-id="long-headline"]');
    await expect(alert.locator('.corroboration-flag')).toHaveText('Single publisher');
    await expect(alert.locator('.propaganda-badge')).toContainText('Caution');
    for (const selector of ['.breaking-alert-headline', '.breaking-alert-meta', '.breaking-alert-provenance']) {
      expect(await alert.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const accessibility = await new AxeBuilder({ page })
      .include('[data-alert-id="long-headline"]')
      .withRules(['color-contrast'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await captureScreenshot(page, testInfo, 'narrow-mobile-single-publisher', {
      locator: page.locator('#app'),
    });
    const headline = alert.locator('.breaking-alert-headline-link');
    await headline.focus();
    await expect(headline).toBeFocused();
    await expect(headline).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Tab');
    await expect(alert.locator('.breaking-alert-view-panel')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(alert.locator('.breaking-alert-dismiss')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(alert).toHaveCount(0);
  });
});
