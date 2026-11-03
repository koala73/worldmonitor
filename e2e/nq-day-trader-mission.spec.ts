import { expect, test, type Page } from '@playwright/test';

const PRESET_KEY = 'worldmonitor-mission-preset-v1';
const WATCHLIST_KEY = 'wm-market-watchlist-v1';
const STORAGE_READ_TIMEOUT_MS = 1_500;
const STORAGE_READ_TIMEOUT = '__wm_storage_read_timeout__';
const DISCLOSURE = 'Context data · 5-minute refresh · not execution-grade';
const ORIGINAL_WATCHLIST = '["AAPL","MSFT","NVDA"]';
const isFinance = process.env.VITE_VARIANT === 'finance';

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

async function waitForEventHandlers(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
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

function nqQuotePayload(asOf: string, includeVxn = true) {
  const quotes = [
    { symbol: 'NQ=F', name: 'E-mini Nasdaq-100', display: 'NQ', price: 21012.5, change: -0.21, sparkline: [21000, 21012] },
    { symbol: 'QQQ', name: 'Invesco QQQ', display: 'QQQ', price: 478.2, change: 0.14, sparkline: [477, 478] },
    { symbol: '^TNX', name: 'US 10-Year Yield', display: 'US 10Y', price: 4.18, change: 0.02, sparkline: [4.16, 4.18] },
  ];
  if (includeVxn) {
    quotes.splice(2, 0, {
      symbol: '^VXN', name: 'Nasdaq-100 VIX', display: 'VXN', price: 18.4, change: 0.8, sparkline: [17.9, 18.4],
    });
  }
  return {
    quotes,
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    unavailableSymbols: includeVxn ? [] : [{ symbol: '^VXN', reason: 'not_found' }],
    asOf,
  };
}

async function fulfillNqQuotes(page: Page, asOf: string, includeVxn = true): Promise<void> {
  await page.route('**/api/market/v1/list-market-quotes**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(nqQuotePayload(asOf, includeVxn)),
    });
  });
  await page.route('**/api/economic/v1/get-economic-calendar**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        events: [],
        fromDate: '2026-08-31',
        toDate: '2026-09-07',
        total: 0,
        unavailable: false,
        asOf,
      }),
    });
  });
  await page.route('**/api/market/v1/list-earnings-calendar**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        earnings: [],
        fromDate: '2026-08-31',
        toDate: '2026-09-14',
        total: 0,
        unavailable: false,
        asOf,
      }),
    });
  });
}

function isNqOnlyFeed(url: string): boolean {
  return /E-mini|Nasdaq\+futures|Nasdaq-100|semiconductor/i.test(decodeURIComponent(url));
}

test.describe('NQ Day Trader mission', () => {
  test.skip(!isFinance, 'Requires VITE_VARIANT=finance');

  test('anonymous finance user can apply and reset without changing the watchlist', async ({ page }) => {
    test.setTimeout(150_000);
    const nqNewsRequests: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((watchlist) => {
      if (sessionStorage.getItem('__nq_mission_e2e_init__')) return;
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('wm-market-watchlist-v1', watchlist);
      sessionStorage.setItem('__nq_mission_e2e_init__', '1');
    }, ORIGINAL_WATCHLIST);
    await installLocalOnlyNetwork(page);
    await fulfillNqQuotes(page, new Date().toISOString(), false);
    page.on('request', (request) => {
      if (request.url().includes('/api/rss-proxy') && isNqOnlyFeed(request.url())) {
        nqNewsRequests.push(request.url());
      }
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForEventHandlers(page);
    await expect(page.locator('#missionPresetBtn')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    expect(nqNewsRequests).toEqual([]);

    await openMissionPopover(page);
    await expect(page.locator('.mission-preset-card')).toHaveCount(8);
    await expect(page.locator('[data-mission-id="nq-day-trader"]')).toContainText('NQ Day Trader');
    await page.locator('[data-mission-id="nq-day-trader"]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBe('nq-day-trader');
    await expect.poll(() => readLocalStorage(page, WATCHLIST_KEY)).not.toBe(STORAGE_READ_TIMEOUT);
    const watchlistAfterApply = await readLocalStorage(page, WATCHLIST_KEY);
    expect(watchlistAfterApply).toBe(ORIGINAL_WATCHLIST);

    await expect.poll(() => readJsonLocalStorage<string[]>(page, 'panel-order').then((order) => order?.slice(0, 3)))
      .toEqual(['nq-pulse', 'nq-catalysts', 'nq-news']);
    await expect(page.locator('.panel[data-panel="nq-pulse"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.panel[data-panel="nq-catalysts"]:not(.hidden)')).toBeVisible();
    await expect(page.locator('.panel[data-panel="nq-news"]:not(.hidden)')).toBeVisible();
    await expect(page.locator('#regionSelect')).toHaveValue('america');
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toContainText(DISCLOSURE);
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toContainText('Unavailable');
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toContainText('NQ');
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toContainText('QQQ');
    await expect(page.locator('.panel[data-panel="nq-catalysts"]')).toContainText('No tracked NQ earnings in this window');

    await openMissionPopover(page);
    await page.locator('[data-mission-reset]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBeNull();
    await expect.poll(() => readLocalStorage(page, WATCHLIST_KEY)).toBe(ORIGINAL_WATCHLIST);
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toBeHidden();
  });

  test('stale quote freshness stays visible and is not labeled Current', async ({ page }) => {
    test.setTimeout(150_000);
    const staleAsOf = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('__nq_stale_e2e_init__')) return;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('__nq_stale_e2e_init__', '1');
    });
    await installLocalOnlyNetwork(page);
    await fulfillNqQuotes(page, staleAsOf, true);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForEventHandlers(page);
    await openMissionPopover(page);
    await page.locator('[data-mission-id="nq-day-trader"]').click();
    const pulse = page.locator('.panel[data-panel="nq-pulse"]:not(.hidden)');
    await expect(pulse).toBeVisible({ timeout: 30_000 });
    await expect(pulse).toContainText('Stale');
    await expect(pulse).not.toContainText('Current');
    await expect(pulse).toContainText(DISCLOSURE);
  });

  test('mobile mission picker keeps NQ selection usable', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('__nq_mobile_e2e_init__')) return;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('__nq_mobile_e2e_init__', '1');
    });
    await installLocalOnlyNetwork(page);
    await fulfillNqQuotes(page, new Date().toISOString(), true);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForEventHandlers(page);
    const moreTab = page.locator('[data-mobile-tab="more"]');
    await expect(moreTab).toBeVisible({ timeout: 30_000 });
    await moreTab.click();
    await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
    await page.locator('#mobileMenuMission').click();
    const popover = page.locator('.mission-preset-popover');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.locator('[data-mission-id="nq-day-trader"]').click();
    await expect.poll(() => readLocalStorage(page, PRESET_KEY)).toBe('nq-day-trader');
    await expect(page.locator('.panel[data-panel="nq-pulse"]:not(.hidden)')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.panel[data-panel="nq-pulse"]')).toContainText(DISCLOSURE);
  });
});
