import { expect, test } from '@playwright/test';

test('gold keeps its last successful data when refresh times out', async ({ page }, testInfo) => {
  let requests = 0;
  await page.route('**/api/market/v1/get-gold-intelligence', async route => {
    if (++requests > 1) return; // The refresh never returns headers.
    await route.fulfill({ json: {
      goldPrice: 2500, goldChangePct: 1.2, goldSparkline: [2400, 2450, 2500],
      silverPrice: 30, platinumPrice: 1000, palladiumPrice: 950,
      crossCurrencyPrices: [], drivers: [], updatedAt: new Date().toISOString(),
    } });
  });
  await page.goto('/tests/map-harness.html');
  await page.evaluate(async () => {
    const modulePath = '/src/components/GoldIntelligencePanel.ts';
    const { GoldIntelligencePanel } = await import(modulePath);
    const panel = new GoldIntelligencePanel();
    document.body.replaceChildren(panel.getElement());
    document.body.style.padding = '24px';
    panel.getElement().style.width = 'min(600px, 100%)';
    await panel.fetchData();
    (window as any).__goldPanel = panel;
  });
  const content = page.locator('.panel-content');
  await expect(content).toContainText('2,500');
  await expect(content).toContainText('Updated just now');
  const result = await page.evaluate(async () => {
    const timeout = AbortSignal.timeout;
    const now = Date.now;
    AbortSignal.timeout = () => timeout(100);
    // The failed refresh happens 20 minutes after the last good load.
    Date.now = () => now() + 20 * 60_000;
    try { return await (window as any).__goldPanel.fetchData(); }
    finally { AbortSignal.timeout = timeout; }
  });
  expect(result).toBe(false);
  // The price stays, and its label reports the real age instead of "just now".
  await expect(content).toContainText('2,500');
  await expect(content).toContainText('Updated 20m ago');
  await expect(content).not.toContainText('Updated just now');
  expect(requests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('gold-refresh-timeout-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('gold-refresh-timeout-mobile.png'), fullPage: true });
});
