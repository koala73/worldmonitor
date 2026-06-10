import { expect, test, type Page } from '@playwright/test';

const PRESET_KEY = 'worldmonitor-mission-preset-v1';

async function seedFreshFullVariant(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__mission_presets_e2e_init__')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
    sessionStorage.setItem('__mission_presets_e2e_init__', '1');
  });
}

async function openMissionPopover(page: Page): Promise<void> {
  const popover = page.locator('.mission-preset-popover');
  if (!(await popover.isVisible().catch(() => false))) {
    await page.locator('#missionPresetBtn').click({ force: true });
  }
  await expect(popover).toBeVisible();
}

test.describe('mission presets', () => {
  test('desktop first-run mission can apply, persist, change, and reset', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedFreshFullVariant(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await openMissionPopover(page);

    await expect(page.locator('.mission-preset-card')).toHaveCount(5);
    await page.locator('[data-mission-id="supply-chain-risk"]').click();

    await expect(page.locator('.panel[data-panel="supply-chain"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#missionPresetBtn')).toContainText('Supply');
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PRESET_KEY)).toBe('supply-chain-risk');
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('panel-order') || '[]')[0]))
      .toBe('supply-chain');
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-layers') || '{}').tradeRoutes))
      .toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#missionPresetBtn')).toContainText('Supply', { timeout: 30_000 });
    await expect(page.locator('.panel[data-panel="supply-chain"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });

    await openMissionPopover(page);
    await page.locator('[data-mission-id="macro-market-watch"]').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PRESET_KEY)).toBe('macro-market-watch');
    await expect(page.locator('#missionPresetBtn')).toContainText('Macro');
    await expect(page.locator('.panel[data-panel="markets"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });

    await openMissionPopover(page);
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PRESET_KEY)).toBeNull();
    await expect(page.locator('#missionPresetBtn')).toContainText('Mission');
  });

  test('mobile mission picker stays in viewport and applies from the mobile menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedFreshFullVariant(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#hamburgerBtn')).toBeVisible({ timeout: 30_000 });
    await page.locator('#hamburgerBtn').click();
    await page.locator('#mobileMenuMission').click();

    const popover = page.locator('.mission-preset-popover');
    await expect(popover).toBeVisible();
    await expect(page.locator('.mission-preset-card')).toHaveCount(5);
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);

    await page.locator('[data-mission-id="energy-security"]').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PRESET_KEY)).toBe('energy-security');
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-layers') || '{}').pipelines ?? false))
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);

    await page.locator('#hamburgerBtn').click();
    await page.locator('#mobileMenuMission').click();
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PRESET_KEY)).toBeNull();
  });
});
