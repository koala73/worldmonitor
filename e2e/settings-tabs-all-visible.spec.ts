import { devices, expect, test, type Page } from '@playwright/test';

// The Settings tab strip used to be one row that scrolled sideways with its
// scrollbar hidden. On a phone that hid later tabs with nothing on screen to
// show they existed. Every tab must now be on screen without scrolling.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
void defaultBrowserType;
const DESKTOP = { viewport: { width: 1440, height: 900 } };

interface TabBox { label: string; top: number; hiddenPx: number }

async function seed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('mobile-map-collapsed');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

async function openSettingsFromMore(page: Page, query = ''): Promise<void> {
  await page.goto(`/dashboard${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
  await page.locator('[data-mobile-tab="more"]').click();
  await page.locator('#mobileMenuSettings').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
}

// For each tab, how many px of its width fall outside the strip's visible box.
function readTabs(page: Page): Promise<TabBox[]> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('#unifiedSettingsModal [role="tablist"]')!;
    const s = strip.getBoundingClientRect();
    return [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
      const t = tab.getBoundingClientRect();
      return {
        label: tab.textContent!.trim().replace(/\s+/g, ' '),
        top: Math.round(t.top - s.top),
        hiddenPx: Math.round(Math.max(0, s.left - t.left) + Math.max(0, t.right - s.right)),
      };
    });
  });
}

function hidden(tabs: TabBox[]): string[] {
  return tabs.filter((t) => t.hiddenPx > 0).map((t) => `${t.label} (${t.hiddenPx}px)`);
}

for (const width of [393, 360]) {
  for (const lang of ['', '?lang=ar']) {
    test.describe(`settings tabs on a ${width}px phone${lang ? ' in Arabic' : ''}`, () => {
      test.use({ ...pixel, viewport: { width, height: 852 } });

      test('every tab is on screen without scrolling', async ({ page }, testInfo) => {
        await seed(page);
        await openSettingsFromMore(page, lang);
        await page.locator('#unifiedSettingsModal [role="tablist"]').screenshot({
          path: testInfo.outputPath(`settings-tabs-${width}${lang ? '-ar' : ''}.png`),
        });
        const tabs = await readTabs(page);
        expect(tabs.length, 'the strip has tabs').toBeGreaterThan(3);
        expect(hidden(tabs), 'tabs cut off by the strip edge').toEqual([]);
      });
    });
  }
}

test.describe('settings tabs on a phone', () => {
  test.use({ ...pixel, viewport: { width: 360, height: 852 } });

  test('the last tab stays in view after a reopen', async ({ page }) => {
    await seed(page);
    await openSettingsFromMore(page);
    const last = page.locator('#unifiedSettingsModal [role="tab"]').last();
    await last.click();
    await expect(last).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(page.locator('#unifiedSettingsModal')).not.toHaveClass(/active/);
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
    await expect(last).toHaveAttribute('aria-selected', 'true');
    expect(hidden(await readTabs(page)), 'tabs cut off after reopening').toEqual([]);
  });

  test('a deep link to a later tab opens with every tab in view', async ({ page }) => {
    await seed(page);
    await page.goto('/dashboard?settings=notifications', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#us-tab-notifications')).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
    expect(hidden(await readTabs(page)), 'tabs cut off on the deep link').toEqual([]);
  });
});

test.describe('settings tabs on a desktop', () => {
  test.use(DESKTOP);

  test('tabs that fit stay on one row', async ({ page }) => {
    await seed(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#unifiedSettingsBtn')).toBeVisible({ timeout: 60_000 });
    await page.locator('#unifiedSettingsBtn').click();
    await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
    const tabs = await readTabs(page);
    expect(hidden(tabs), 'tabs cut off on a desktop').toEqual([]);
    expect(new Set(tabs.map((t) => t.top)).size, 'all tabs share one row').toBe(1);
  });
});

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 600 }, { width: 844, height: 390 }]) {
  test.describe(`compact Settings at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test('keeps the first control clear of the pinned links and navigation', async ({ page }) => {
      await seed(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
      if (viewport.width <= 768) {
        await page.locator('[data-mobile-tab="more"]').tap();
        await page.locator('#mobileMenuSettings').tap();
      } else {
        await page.locator('#unifiedSettingsBtn').tap();
      }
      const modal = page.locator('.unified-settings-modal');
      await expect(modal).toBeVisible();
      const theme = modal.locator('#us-tab-panel-settings select').first();
      const controlBox = await theme.boundingBox();
      const links = modal.locator('.dashboard-chrome-links');
      const linksBox = await links.boundingBox();
      expect(controlBox).not.toBeNull();
      expect(linksBox).not.toBeNull();
      expect(controlBox!.y + controlBox!.height, 'Theme control is above the pinned links').toBeLessThanOrEqual(linksBox!.y);
      if (viewport.width <= 768) {
        const nav = await page.locator('#mobileTabBar').boundingBox();
        const box = await modal.boundingBox();
        expect(box!.y + box!.height, 'Settings clears the phone navigation').toBeLessThanOrEqual(nav!.y);
      }
      expect(hidden(await readTabs(page)), 'all Settings tabs remain visible').toEqual([]);
      await theme.selectOption('light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await page.evaluate(() => localStorage.getItem('worldmonitor-theme'))).toBe('light');
      await modal.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(links.locator('a').last()).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });
  });
}
