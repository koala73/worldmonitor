import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';

// On a phone, Settings is a full-height sheet above the tab bar, and device
// Back walks it: from a page Back returns to the home list, and from the list
// Back closes Settings.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
void defaultBrowserType;

test.use({ ...pixel, viewport: { width: 393, height: 852 } });

async function seed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('mobile-map-collapsed');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

async function boot(page: Page, query = ''): Promise<void> {
  await seed(page);
  await page.goto(`/dashboard${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-mobile-tab="more"]').click();
  await page.locator('#mobileMenuSettings').click();
  await expect(page.locator('[data-settings-home]')).toBeVisible();
}

const sheet = (page: Page) => page.locator('.unified-settings-modal');
const settingsOpen = (page: Page) => page.locator('#unifiedSettingsModal.active');
const scrollTop = (page: Page) => sheet(page).evaluate((el) => el.scrollTop);

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include('#unifiedSettingsModal')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), label).toEqual([]);
}

test('device Back returns from a page to the list with focus on its row, then closes Settings', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  const row = page.locator('[data-settings-nav="about"]');
  await row.click();
  await expect(page.locator('#us-page-about')).toBeVisible();

  await page.goBack();
  await expect(page.locator('[data-settings-home]')).toBeVisible();
  await expect(page.locator('#us-page-about')).toBeHidden();
  await expect(row).toBeFocused();
  await expect(settingsOpen(page)).toHaveCount(1);

  await page.goBack();
  await expect(settingsOpen(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/dashboard');
});

test('a deep link to a page leaves the home list beneath it', async ({ page }) => {
  await boot(page, '?settings=notifications');
  await expect(page.locator('#us-page-notifications')).toBeVisible({ timeout: 60_000 });

  await page.goBack();
  await expect(page.locator('[data-settings-home]')).toBeVisible();
  await expect(settingsOpen(page)).toHaveCount(1);

  await page.goBack();
  await expect(settingsOpen(page)).toHaveCount(0);
});

test('the sheet fills the screen from the top down to the tab bar', async ({ page }) => {
  await boot(page);
  await openSettings(page);

  const box = (await sheet(page).boundingBox())!;
  const bar = (await page.locator('#mobileTabBar').boundingBox())!;
  expect(box.y, 'the sheet starts at the top of the screen').toBe(0);
  expect(box.x).toBe(0);
  expect(box.width).toBe(393);
  expect(box.y + box.height, 'the sheet ends where the tab bar begins').toBeCloseTo(bar.y, 0);
  await expect(page.locator('#mobileTabBar')).toBeVisible();

  const overflow = await page.evaluate(() => ({
    sheet: document.querySelector('.unified-settings-modal')!.scrollWidth - document.querySelector('.unified-settings-modal')!.clientWidth,
    page: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow, 'nothing scrolls sideways').toEqual({ sheet: 0, page: 0 });

  await sheet(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const header = (await page.locator('#unifiedSettingsModal .modal-header').boundingBox())!;
  expect(header.y, 'the header stays at the top while the list scrolls').toBe(0);
});

test('a page opens at its top and Back returns the list to where it was', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await sheet(page).evaluate((el) => { el.scrollTop = 80; });
  // A click scrolls an off-screen row into view first, which would move the baseline.
  await page.locator('[data-settings-nav="about"]').scrollIntoViewIfNeeded();
  const listOffset = await scrollTop(page);
  expect(listOffset).toBeGreaterThan(0);

  await page.locator('[data-settings-nav="about"]').click();
  await expect(page.locator('#us-page-about')).toBeVisible();
  expect(await scrollTop(page)).toBe(0);
  await sheet(page).evaluate((el) => { el.scrollTop = 200; });

  await page.goBack();
  await expect(page.locator('[data-settings-home]')).toBeVisible();
  expect(await scrollTop(page)).toBe(listOffset);

  await page.locator('[data-settings-nav="about"]').click();
  expect(await scrollTop(page)).toBe(0);
});

test('the home list and a page pass axe', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await openSettings(page);
  await expectNoAxeViolations(page, 'home list');

  await page.locator('[data-settings-nav="display"]').click();
  await expect(page.locator('#us-page-display')).toBeVisible();
  await expectNoAxeViolations(page, 'Display page');
});
