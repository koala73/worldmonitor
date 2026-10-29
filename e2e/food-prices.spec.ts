import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/food-prices/card.json', import.meta.url), 'utf8'));

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`food prices: source selection and dated context at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/api/economic/v1/get-food-prices*', route => route.fulfill({ json: fixture }));
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      localStorage.setItem('wm-pro-key', 'wm-test-food-prices');
      localStorage.setItem('worldmonitor-panels', JSON.stringify({ 'fao-food-price-index': { name: 'Food prices', enabled: true, priority: 0 } }));
    });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true');
    const panel = page.locator('[data-panel="fao-food-price-index"]');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByLabel('Country', { exact: true }).selectOption('da');
    await expect(panel.locator('.food-prices-table').first()).toContainText('PHP');
    await panel.getByLabel('Country', { exact: true }).selectOption('cbsl');
    await expect(panel.locator('.food-prices-table').first()).toContainText('LKR');
    await panel.locator('summary').click();
    await panel.getByLabel('Country brief', { exact: true }).selectOption('MYS');
    await expect(panel.locator('details')).toHaveAttribute('open', '');
    await expect(panel.locator('details')).toContainText('Unavailable');
    await expect(panel.locator('details')).toContainText('2026-07-01');
    await expect(panel.locator('details')).not.toContainText('Week over week');
    await panel.getByLabel('Country', { exact: true }).selectOption('da');
    await panel.locator('.food-prices-card h3').scrollIntoViewIfNeeded();
    await expect(panel.getByLabel('Country', { exact: true })).toBeVisible();
    const overflow = await panel.evaluate(element => ({ panel: element.scrollWidth - element.clientWidth, document: document.documentElement.scrollWidth - innerWidth }));
    expect(overflow).toEqual({ panel: 0, document: 0 });
  });
}

for (const failure of ['http', 'empty']) {
  test(`food prices: monthly ${failure} recovery keeps local prices`, async ({ page }) => {
    let failed = true;
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/api/economic/v1/get-food-prices*', route => route.fulfill({ json: fixture }));
    await page.route('**/api/economic/v1/get-fao-food-price-index*', route => failed
      ? route.fulfill({ status: failure === 'http' ? 503 : 200, json: {} })
      : route.fulfill({ json: { points: [{ date: '2026-09', ffpi: 126 }], currentFfpi: 126, momPct: 0.8, yoyPct: 2.1 } }));
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      localStorage.setItem('wm-pro-key', 'wm-test-food-prices');
      localStorage.setItem('worldmonitor-panels', JSON.stringify({ 'fao-food-price-index': { name: 'Food prices', enabled: true, priority: 0 } }));
    });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true');
    const panel = page.locator('[data-panel="fao-food-price-index"]');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByLabel('Country', { exact: true }).selectOption('da');
    await expect(panel.locator('.food-prices-table').first()).toContainText('PHP');
    const monthly = panel.locator('.fao-monthly-context');
    await expect(monthly.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    failed = false;
    await monthly.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(monthly.locator('.fao-index-value')).toHaveText('126.0');
    await expect(panel.locator('.food-prices-table').first()).toContainText('PHP');
  });
}

for (const degraded of [{ sources: [] }, { unavailable: true, sources: fixture.sources }]) {
  test(`food prices: local ${degraded.unavailable ? 'unavailable' : 'empty'} response offers recovery`, async ({ page }) => {
    let failed = true;
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/api/economic/v1/get-food-prices*', route => route.fulfill({ json: failed ? degraded : fixture }));
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      localStorage.setItem('wm-pro-key', 'wm-test-food-prices');
      localStorage.setItem('worldmonitor-panels', JSON.stringify({ 'fao-food-price-index': { name: 'Food prices', enabled: true, priority: 0 } }));
    });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true');
    const panel = page.locator('[data-panel="fao-food-price-index"]');
    await panel.scrollIntoViewIfNeeded();
    const card = panel.locator('.food-prices-card');
    await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    failed = false;
    await card.getByRole('button', { name: 'Retry', exact: true }).click();
    await card.getByLabel('Country', { exact: true }).selectOption('da');
    await expect(card.locator('.food-prices-table').first()).toContainText('PHP');
    await expect(card.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  });
}
