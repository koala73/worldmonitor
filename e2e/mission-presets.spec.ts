import { expect, test, type Page } from '@playwright/test';

const PRESET_KEY = 'worldmonitor-mission-preset-v1';
const STORAGE_READ_TIMEOUT_MS = 1_500;
const STORAGE_READ_TIMEOUT = '__wm_storage_read_timeout__';
const ACTIVE_VARIANT = process.env.VITE_VARIANT || 'full';
const MISSION_CARD_COUNT = ACTIVE_VARIANT === 'finance' ? 9 : 8;
const DEFAULT_TRADE_ROUTES = ACTIVE_VARIANT === 'finance' || ACTIVE_VARIANT === 'energy' || ACTIVE_VARIANT === 'commodity';

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

async function seedFreshVariant(page: Page): Promise<void> {
  const variant = process.env.VITE_VARIANT || 'full';
  await page.addInitScript((selectedVariant) => {
    if (sessionStorage.getItem('__mission_presets_e2e_init__')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', selectedVariant);
    sessionStorage.setItem('__mission_presets_e2e_init__', '1');
  }, variant);
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

type IdleHoldWindow = typeof window & { __wmFlushIdle?: () => number };

/**
 * Queue every `requestIdleCallback` for the life of the page. Nothing runs until
 * `releaseIdleCallbacks` flushes the queue, so a test decides where the first
 * idle period lands relative to its own actions, and no callback can slip out
 * later through the native scheduler.
 */
async function holdIdleCallbacks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const held: Array<() => void> = [];
    window.requestIdleCallback = ((cb: IdleRequestCallback) => {
      held.push(() => cb({ didTimeout: true, timeRemaining: () => 0 }));
      return 0;
    }) as typeof window.requestIdleCallback;
    (window as IdleHoldWindow).__wmFlushIdle = () => {
      const batch = held.splice(0);
      for (const run of batch) run();
      return batch.length;
    };
  });
}

/**
 * Flush the held idle callbacks once the Mission prompt's is among them.
 *
 * `scheduleAfterFirstPaint` queues it two animation frames after `load`, so
 * wait for `load` and then three frames: the page's two-frame chain started no
 * later than ours and has queued by the time ours ends. Then wait two more
 * frames for anything the callbacks mount.
 */
async function releaseIdleCallbacks(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const flushed = await page.evaluate(() => (window as IdleHoldWindow).__wmFlushIdle?.() ?? 0);
  expect(flushed, 'the Mission prompt callback must be queued before the release').toBeGreaterThan(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForEventHandlers(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function setupMissionPage(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await seedFreshVariant(page);
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

async function expectFreeMissionPanelLimit(page: Page): Promise<void> {
  const settings = await readJsonLocalStorage<Record<string, { enabled: boolean }>>(page, 'worldmonitor-panels');
  expect(settings).not.toBeNull();
  const counted = Object.entries(settings!).filter(([key, config]) =>
    config.enabled && key !== 'map' && !key.startsWith('cw-'));
  expect(counted.length).toBeLessThanOrEqual(40);
  expect(settings!.map?.enabled).toBe(true);
  const disabledKeys = Object.entries(settings!).filter(([, config]) => !config.enabled).map(([key]) => key);
  await expect.poll(() => page.locator('.panel[data-panel]:visible').evaluateAll((panels, disabled) =>
    panels.filter((panel) => disabled.includes(panel.getAttribute('data-panel') ?? '')).length,
  disabledKeys)).toBe(0);
}

test.describe('mission presets', () => {
  test('desktop first-run mission can apply and persist across reload', async ({ page }) => {
    test.setTimeout(150_000);
    await setupMissionPage(page, { width: 1440, height: 900 });

    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await openMissionPopover(page);

    await expect(page.locator('.mission-preset-card')).toHaveCount(MISSION_CARD_COUNT);
    if (ACTIVE_VARIANT === 'finance') {
      await expect(page.locator('[data-mission-id="nq-day-trader"]')).toContainText('NQ Day Trader');
    } else {
      await expect(page.locator('[data-mission-id="nq-day-trader"]')).toHaveCount(0);
    }
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

  test('first-run prompt does not open over a modal the user already opened', async ({ page }) => {
    // The prompt auto-opens on the first idle period after paint. On a slow
    // machine that idle period can land after the user has opened a modal; the
    // prompt then took focus and swallowed that modal's Escape, so the modal
    // could not be closed from the keyboard (the WebMCP settings smoke failed
    // that way on a CI runner). Hold idle callbacks to force that ordering.
    test.setTimeout(150_000);
    await holdIdleCallbacks(page);
    await setupMissionPage(page, { width: 1440, height: 900 });
    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.mission-preset-popover')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await expect(page.locator('.search-overlay')).toBeVisible();

    await releaseIdleCallbacks(page);
    await expect(page.locator('.mission-preset-popover')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.search-overlay')).toBeHidden();
  });

  test('first-run prompt still auto-opens on a late idle period when no modal is open', async ({ page }) => {
    // Positive control for the test above: the same held-then-released idle
    // period must still open the prompt, or that test proves nothing.
    test.setTimeout(150_000);
    await holdIdleCallbacks(page);
    await setupMissionPage(page, { width: 1440, height: 900 });
    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.mission-preset-popover')).toHaveCount(0);

    await releaseIdleCallbacks(page);
    await expect(page.locator('.mission-preset-popover')).toBeVisible();
  });

  test('desktop mission can apply and reset to default state', async ({ page }, testInfo) => {
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
    await expectFreeMissionPanelLimit(page);
    await expect
      .poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.[0]))
      .toBe('live-news');
    await expect
      .poll(() => readJsonLocalStorage<Record<string, boolean>>(page, 'worldmonitor-layers').then((layers) => layers?.tradeRoutes ?? false))
      .toBe(DEFAULT_TRADE_ROUTES);
    await page.screenshot({ path: testInfo.outputPath('desktop-mission-reset-capped.png') });
  });

  test('mobile mission picker stays in viewport and applies from the mobile menu', async ({ page }, testInfo) => {
    await setupMissionPage(page, { width: 390, height: 844 });
    const moreTab = page.locator('[data-mobile-tab="more"]');
    await expect(moreTab).toBeVisible({ timeout: 30_000 });
    await moreTab.click();
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
    await expect(page.locator('.mission-preset-card')).toHaveCount(MISSION_CARD_COUNT);
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

    await moreTab.click();
    await page.locator('#mobileMenuMission').click();
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBeNull();
    await expectFreeMissionPanelLimit(page);
    await page.waitForFunction(() => {
      const menu = document.getElementById('mobileMenu');
      return !menu || menu.getBoundingClientRect().right <= 0;
    });
    await page.screenshot({ path: testInfo.outputPath('mobile-mission-reset-capped.png') });
  });
});
