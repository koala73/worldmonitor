import { expect, test, type Page } from '@playwright/test';
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
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto('/tests/breaking-news-banner-harness.html');
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const w = window as HarnessWindow;
        return Boolean(w.__breakingNewsBannerHarness?.ready);
      });
    }, { timeout: 45_000 })
    .toBe(true);
}

async function harnessLayout(page: Page): Promise<'overlay' | 'in-flow' | null> {
  return await page.evaluate(() => {
    const w = window as HarnessWindow;
    return w.__breakingNewsBannerHarness?.layout ?? null;
  });
}

async function assertBadgeColourSemantics(page: Page): Promise<void> {
  const banner = page.locator('.breaking-news-container');
  await expect(banner.locator('.breaking-alert')).toHaveCount(3);

  const reuters = banner.locator('.breaking-alert', { hasText: 'Reuters' });
  await expect(reuters.locator('.tier-badge.tier-1')).toHaveText('★ Wire');
  await expect(reuters.locator('.propaganda-badge')).toHaveCount(0);
  await expect(reuters.locator('.tier-badge.tier-1')).toHaveCSS('color', 'rgb(68, 255, 136)');
  await expect(banner.locator('.breaking-alert-time').first()).toHaveText('· just now');

  const alJazeera = banner.locator('.breaking-alert', { hasText: 'Al Jazeera' });
  await expect(alJazeera.locator('.tier-badge.tier-2')).toBeVisible();
  await expect(alJazeera.locator('.propaganda-badge.medium')).toContainText('Caution');
  await expect(alJazeera.locator('.propaganda-badge.medium')).toHaveCSS('color', 'rgb(255, 170, 0)');

  const miit = banner.locator('.breaking-alert', { hasText: 'MIIT (China)' });
  await expect(miit.locator('.tier-badge.tier-1')).toHaveText('★');
  await expect(miit.locator('.propaganda-badge.high')).toHaveText('Official Government Source');
  await expect(miit.locator('.propaganda-badge.high')).toHaveCSS('color', 'rgb(255, 68, 68)');
}

test.describe('breaking news banner provenance screenshots', () => {
  test('desktop overlay keeps news-list badge colours', async ({ page }, testInfo) => {
    await loadHarness(page, { width: 1280, height: 720 });
    expect(await harnessLayout(page)).toBe('overlay');

    const banner = page.locator('.breaking-news-container');
    await expect(banner).toBeVisible();
    await assertBadgeColourSemantics(page);

    const position = await banner.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('fixed');

    const overflowX = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX).toBeLessThanOrEqual(1);

    await expect(banner).toHaveScreenshot('desktop-overlay.png', {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.04,
    });
    const screenshot = await captureScreenshot(page, testInfo, 'desktop-overlay', {
      locator: banner,
    });
    expect(screenshot).toBeTruthy();
    expectPngScreenshot(await page.screenshot({ fullPage: false, animations: 'disabled' }), 'desktop');
  });

  test('mobile in-flow keeps news-list badge colours without overflow', async ({ page }, testInfo) => {
    await loadHarness(page, { width: 390, height: 844 });
    expect(await harnessLayout(page)).toBe('in-flow');

    const banner = page.locator('.breaking-news-container');
    await expect(banner).toBeVisible();
    await assertBadgeColourSemantics(page);

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
    await expect(appShell).toHaveScreenshot('mobile-in-flow.png', {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.04,
    });
    const screenshot = await captureScreenshot(page, testInfo, 'mobile-in-flow', {
      locator: appShell,
    });
    expect(screenshot).toBeTruthy();
    expectPngScreenshot(await page.screenshot({ fullPage: false, animations: 'disabled' }), 'mobile');
  });
});
