import { expect, test, type Page } from '@playwright/test';

const PRESET_KEY = 'worldmonitor-mission-preset-v1';
const STORAGE_READ_TIMEOUT_MS = 1_500;
const STORAGE_READ_TIMEOUT = '__wm_storage_read_timeout__';

async function installLocalOnlyNetwork(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });
}

async function readLocalStorage(page: Page, key: string): Promise<string | null> {
  const origin = new URL(page.url()).origin;
  const read = async (): Promise<string | null> => {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('DOMStorage.enable');
      const result = await session.send('DOMStorage.getDOMStorageItems', {
        storageId: { securityOrigin: origin, isLocalStorage: true },
      });
      const entries = result.entries as Array<[string, string]>;
      return entries.find(([name]) => name === key)?.[1] ?? null;
    } finally {
      await session.detach().catch(() => {});
    }
  };

  return await Promise.race([
    read(),
    new Promise<string>((resolve) => setTimeout(() => resolve(STORAGE_READ_TIMEOUT), STORAGE_READ_TIMEOUT_MS)),
  ]);
}

async function readJsonLocalStorage<T>(page: Page, key: string): Promise<T | null> {
  const value = await readLocalStorage(page, key);
  if (value === STORAGE_READ_TIMEOUT) return null;
  return value ? JSON.parse(value) as T : null;
}

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
  await expect(popover).toBeVisible({ timeout: 1_500 }).catch(async () => {
    await page.locator('#missionPresetBtn').click({ force: true });
  });
  await expect(popover).toBeVisible();
}

async function waitForEventHandlers(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function setupMissionPage(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await seedFreshFullVariant(page);
  await installLocalOnlyNetwork(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForEventHandlers(page);
}

async function waitForMobileMenuSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const menu = document.getElementById('mobileMenu');
    return !!menu && menu.classList.contains('open') && Math.round(menu.getBoundingClientRect().left) >= 0;
  });
}

async function applyMission(page: Page, missionId: string, label: string): Promise<void> {
  await openMissionPopover(page);
  await page.locator(`[data-mission-id="${missionId}"]`).click();
  await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBe(missionId);
  await expect(page.locator('#missionPresetBtn')).toContainText(label);
}

test.describe('mission presets', () => {
  test('desktop first-run mission can apply and persist across reload', async ({ page }) => {
    test.setTimeout(150_000);
    await setupMissionPage(page, { width: 1440, height: 900 });

    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await openMissionPopover(page);

    await expect(page.locator('.mission-preset-card')).toHaveCount(7);
    await applyMission(page, 'supply-chain-risk', 'Supply');

    await expect(page.locator('.panel[data-panel="supply-chain"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.[0]))
      .toBe('supply-chain');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.tradeRoutes))
      .toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEventHandlers(page);
    await expect(page.locator('#missionPresetBtn')).toContainText('Supply', { timeout: 30_000 });
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBe('supply-chain-risk');
    await expect(page.locator('.panel[data-panel="supply-chain"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.[0]))
      .toBe('supply-chain');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.tradeRoutes))
      .toBe(true);
  });

  test('desktop mission can apply and reset to default state', async ({ page }) => {
    test.setTimeout(150_000);
    await setupMissionPage(page, { width: 1440, height: 900 });

    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await applyMission(page, 'macro-market-watch', 'Stocks');
    await expect(page.locator('.panel[data-panel="markets"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#regionSelect')).toHaveValue('america');
    await expect
      .poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.[0]))
      .toBe('markets');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.tradeRoutes))
      .toBe(true);

    await openMissionPopover(page);
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBeNull();
    await expect(page.locator('#missionPresetBtn')).toContainText('Mission');
    await expect(page.locator('#regionSelect')).toHaveValue('global');
    await expect
      .poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.[0]))
      .toBe('live-news');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.tradeRoutes))
      .toBe(false);
  });

  test('mobile mission picker stays in viewport and applies from the mobile menu', async ({ page }) => {
    await setupMissionPage(page, { width: 390, height: 844 });
    await expect(page.locator('#hamburgerBtn')).toBeVisible({ timeout: 30_000 });
    await page.locator('#hamburgerBtn').click();
    await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
    await waitForMobileMenuSettled(page);
    const mobileMission = page.locator('#mobileMenuMission');
    await expect(mobileMission).toBeVisible();
    const missionBox = await mobileMission.boundingBox();
    expect(missionBox).not.toBeNull();
    expect(missionBox!.x).toBeGreaterThanOrEqual(0);
    expect(missionBox!.y).toBeGreaterThanOrEqual(0);
    expect(missionBox!.x + missionBox!.width).toBeLessThanOrEqual(390);
    expect(missionBox!.y + missionBox!.height).toBeLessThanOrEqual(844);
    await mobileMission.click();

    const popover = page.locator('.mission-preset-popover');
    await expect(popover).toBeVisible();
    await expect(page.locator('.mission-preset-card')).toHaveCount(7);
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);

    await page.locator('[data-mission-id="energy-security"]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBe('energy-security');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.pipelines ?? false))
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);

    await page.locator('#hamburgerBtn').click();
    await page.locator('#mobileMenuMission').click();
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBeNull();
  });
});
