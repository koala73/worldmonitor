import { expect, test, type Page } from '@playwright/test';
import { FONT_SCALE_STORAGE_KEY } from '../src/services/font-scale-settings';

const STEPS = ['0.9', '1', '1.1', '1.25', '1.5', '2'] as const;
const GLOBAL_STORAGE_KEY = FONT_SCALE_STORAGE_KEY;
const PANELS_STORAGE_KEY = 'worldmonitor-panels';
const TABS_STORAGE_KEY = 'worldmonitor-tabs-v1:full';

async function seedDashboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__panel_font_scale_seeded__')) return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('__panel_font_scale_seeded__', '1');
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('wm-pro-key', 'e2e-panel-font-scale');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });

  await page.route('**/api/market/v1/get-fear-greed-index', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      compositeScore: 62,
      compositeLabel: 'Greed',
      previousScore: 55,
      volatility: { score: 62, weight: 0.1, contribution: 6.2, degraded: false },
      unavailable: false,
    }),
  }));

  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, route =>
    route.abort('blockedbyclient'));
}

async function bootDashboard(page: Page): Promise<void> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
  await expect(page.locator('#panelsGrid > .panel:not(.hidden) .panel-title').first()).toBeVisible({
    timeout: 60_000,
  });
}

async function openSettings(page: Page): Promise<void> {
  const mobile = await page.evaluate(() => window.innerWidth <= 768);
  if (mobile) {
    await page.locator('[data-mobile-tab="more"]').click();
  }
  const button = page.locator(mobile ? '#mobileMenuSettings' : '#unifiedSettingsBtn');
  await expect(button).toBeVisible({ timeout: 60_000 });
  await button.click();
  await expect(page.locator('#unifiedSettingsModal')).toBeVisible();
}

async function fontSize(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate(element =>
    Number.parseFloat(getComputedStyle(element).fontSize));
}

test.describe('panel font scaling', () => {
  test.beforeEach(async ({ page }) => {
    await seedDashboard(page);
  });

  test('applies every global step, persists it, and keeps fixed map chrome unchanged', async ({ page }) => {
    await bootDashboard(page);

    const panelTitle = '#panelsGrid > .panel:not(.hidden) .panel-title';
    const panelBodyText = '.panel[data-panel="live-news"] .live-media-shell-title';
    const mapTitle = '#mapSection > .panel-header .panel-title';
    await expect(page.locator(panelBodyText)).toBeVisible();
    const basePanelSize = await fontSize(page, panelTitle);
    const basePanelBodySize = await fontSize(page, panelBodyText);
    const baseMapSize = await fontSize(page, mapTitle);

    await openSettings(page);
    const select = page.locator('#us-font-scale');
    await expect(select).toHaveValue('1');
    await expect(select.locator('option')).toHaveCount(STEPS.length);

    for (const step of STEPS) {
      await select.selectOption(step);
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--wm-font-scale'))).toBe(step);
      expect(await fontSize(page, panelTitle)).toBeCloseTo(basePanelSize * Number(step), 1);
      expect(await fontSize(page, panelBodyText)).toBeCloseTo(basePanelBodySize * Number(step), 1);
      expect(await fontSize(page, mapTitle)).toBeCloseTo(baseMapSize, 1);
    }

    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), GLOBAL_STORAGE_KEY)).toBe('2');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
    await expect(page.locator(panelTitle).first()).toBeVisible({ timeout: 60_000 });
    expect(await fontSize(page, panelTitle)).toBeCloseTo(basePanelSize * 2, 1);
    expect(await fontSize(page, mapTitle)).toBeCloseTo(baseMapSize, 1);

    await openSettings(page);
    await expect(page.locator('#us-font-scale')).toHaveValue('2');
  });

  test('keeps an open scale selector current after storage and cloud reconciliation', async ({ context, page }) => {
    await bootDashboard(page);
    await openSettings(page);
    const select = page.locator('#us-font-scale');
    await expect(select).toHaveValue('1');

    const peer = await context.newPage();
    await peer.goto('/robots.www.txt', { waitUntil: 'domcontentloaded' });
    await peer.evaluate(key => localStorage.setItem(key, '2'), GLOBAL_STORAGE_KEY);

    await expect.poll(() => page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--wm-font-scale'))).toBe('2');
    await expect(select).toHaveValue('2');
    await peer.close();

    await page.evaluate(key => {
      localStorage.setItem(key, '1.5');
      window.dispatchEvent(new CustomEvent('wm:cloud-prefs-applied', {
        detail: { keys: [key], syncVersion: 1 },
      }));
    }, GLOBAL_STORAGE_KEY);

    await expect.poll(() => page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--wm-font-scale'))).toBe('1.5');
    await expect(select).toHaveValue('1.5');
  });

  test('keeps gauge labels and analyst controls uncut at 200%', async ({ page }) => {
    await bootDashboard(page);
    await openSettings(page);
    await page.locator('#us-font-scale').selectOption('2');
    await page.locator('.unified-settings-close').click();

    const gaugePanel = page.locator('.panel[data-panel="fear-greed"]');
    await gaugePanel.scrollIntoViewIfNeeded();
    const gauge = gaugePanel.locator('[data-gauge-role="root"]');
    await expect(gauge).toBeVisible({ timeout: 60_000 });
    const gaugeGeometry = await gauge.evaluate((root) => {
      const box = (selector: string) => {
        const rect = root.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      };
      const rootRect = root.getBoundingClientRect();
      return {
        root: { top: rootRect.top, bottom: rootRect.bottom },
        svg: box('svg'),
        pivot: box('svg circle'),
        score: box('[data-gauge-role="score"]'),
        label: box('[data-gauge-role="label"]'),
        delta: box('[data-gauge-role="delta"]'),
      };
    });
    expect(gaugeGeometry.pivot.bottom).toBeLessThanOrEqual(gaugeGeometry.svg.bottom + 0.5);
    expect(gaugeGeometry.score.bottom).toBeLessThanOrEqual(gaugeGeometry.label.top + 0.5);
    expect(gaugeGeometry.label.bottom).toBeLessThanOrEqual(gaugeGeometry.delta.top + 0.5);
    expect(gaugeGeometry.delta.bottom).toBeLessThanOrEqual(gaugeGeometry.root.bottom + 0.5);

    const chatPanel = page.locator('.panel[data-panel="chat-analyst"]');
    await chatPanel.scrollIntoViewIfNeeded();
    const chatButtons = chatPanel.locator('.chat-analyst-send, .chat-analyst-clear, .chat-analyst-export');
    await expect(chatButtons).toHaveCount(3);
    await expect(chatButtons.first()).toBeVisible({ timeout: 60_000 });
    const clipping = await chatButtons.evaluateAll(buttons => buttons.map((button) => {
      const element = button as HTMLElement;
      const row = element.closest<HTMLElement>('.chat-analyst-input-row')!;
      const buttonRect = element.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        content: element.scrollHeight - element.clientHeight,
        top: rowRect.top - buttonRect.top,
        bottom: buttonRect.bottom - rowRect.bottom,
      };
    }));
    for (const button of clipping) {
      expect(button.content).toBeLessThanOrEqual(0);
      expect(button.top).toBeLessThanOrEqual(0.5);
      expect(button.bottom).toBeLessThanOrEqual(0.5);
    }
  });

  test('persists an absolute panel override and captures it in the active tab snapshot', async ({ page }) => {
    await bootDashboard(page);
    const firstPanel = page.locator('#panelsGrid > .panel:not(.hidden)').first();
    const panelId = await firstPanel.getAttribute('data-panel');
    expect(panelId).toBeTruthy();

    await openSettings(page);
    await page.locator('#us-font-scale').selectOption('2');
    await page.locator('#us-tab-panels').click();

    const panelScale = page.locator(`#usPanelToggles [data-panel-font-scale="${panelId}"]`);
    await expect(panelScale).toBeVisible({ timeout: 15_000 });
    await expect(panelScale).toHaveValue('global');
    await panelScale.selectOption('0.9');
    await expect(page.locator('.panels-save-layout')).toBeEnabled();
    await page.locator('.panels-save-layout').click();
    await page.locator('.unified-settings-close').click();

    const targetTitle = `.panel[data-panel="${panelId}"] .panel-title`;
    const globalTitle = `.panel[data-panel]:not([data-panel="${panelId}"]):not(.hidden) .panel-title`;
    const targetSize = await fontSize(page, targetTitle);
    const globalSize = await fontSize(page, globalTitle);
    expect(globalSize / targetSize).toBeCloseTo(2 / 0.9, 1);

    await expect.poll(() => page.evaluate(
      ({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id]?.fontScale,
      { key: PANELS_STORAGE_KEY, id: panelId! },
    )).toBe(0.9);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
    await expect(page.locator(targetTitle)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => fontSize(page, targetTitle)).toBeCloseTo(targetSize, 1);

    await openSettings(page);
    await expect(page.locator('#us-font-scale')).toHaveValue('2');
    await page.locator('#us-tab-panels').click();
    await expect(page.locator(`#usPanelToggles [data-panel-font-scale="${panelId}"]`)).toHaveValue('0.9');
    await page.locator('.unified-settings-close').click();

    await page.locator('.dashboard-tab-add').click();
    await expect(page.locator('.dashboard-tab')).toHaveCount(2);
    const tabSnapshot = await page.evaluate(
      ({ key, id }) => {
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        return {
          first: state.tabs?.[0]?.panelSettings?.[id]?.fontScale,
          second: state.tabs?.[1]?.panelSettings?.[id]?.fontScale,
        };
      },
      { key: TABS_STORAGE_KEY, id: panelId! },
    );
    expect(tabSnapshot).toEqual({ first: 0.9, second: undefined });

    await page.locator('.dashboard-tab-label').first().click();
    await expect.poll(() => fontSize(page, targetTitle)).toBeCloseTo(targetSize, 1);

    await openSettings(page);
    await page.locator('#us-tab-panels').click();
    await page.locator(`#usPanelToggles [data-panel-font-scale="${panelId}"]`).selectOption('global');
    await page.locator('.panels-save-layout').click();
    await page.locator('.unified-settings-close').click();
    await expect.poll(() => fontSize(page, targetTitle)).toBeCloseTo(globalSize, 1);
    await expect.poll(() => page.evaluate(
      ({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id]?.fontScale,
      { key: PANELS_STORAGE_KEY, id: panelId! },
    )).toBeUndefined();
  });

  for (const viewport of [
    { label: 'small', width: 390, height: 844 },
    { label: 'wide', width: 2537, height: 1270 },
  ]) {
    test(`keeps the panel grid within the ${viewport.label} viewport at 200%`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await bootDashboard(page);
      await openSettings(page);
      await page.locator('#us-font-scale').selectOption('2');
      await page.locator('.unified-settings-close').click();

      const overflow = await page.evaluate(() => {
        const grid = document.getElementById('panelsGrid');
        if (!grid) throw new Error('Panel grid did not render');
        return {
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          grid: grid.scrollWidth - grid.clientWidth,
        };
      });
      expect(overflow.document).toBeLessThanOrEqual(1);
      expect(overflow.grid).toBeLessThanOrEqual(1);
    });
  }
});
