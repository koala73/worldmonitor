import { expect, test } from '@playwright/test';

test('hostile feed fields remain text in map tooltips and COT rows', async ({ page }, testInfo) => {
  const hostile = '<img src=x onerror="alert(1)">';
  await page.route('**/api/market/v1/get-cot-positioning*', route => route.fulfill({ json: {
    reportDate: hostile, instruments: [{ code: 'CL', name: hostile, assetManagerLong: '20', assetManagerShort: '10' }],
  } }));
  await page.route('**/api/market/v1/list-market-quotes*', route => route.fulfill({ json: { quotes: [] } }));
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async (value) => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { LiquidityShiftsPanel } = await import('/src/components/LiquidityShiftsPanel.ts');
    const { DeckGLMap } = await import('/src/components/DeckGLMap.ts');
    const panel = new LiquidityShiftsPanel();
    panel.getElement().style.cssText = 'position:relative;width:min(100%,720px);height:340px';
    document.body.style.cssText = 'display:block;overflow:auto';
    document.body.replaceChildren(panel.getElement());
    await panel.fetchData();
    const tooltip = document.createElement('section');
    tooltip.id = 'feed-tooltip-fixture';
    tooltip.style.padding = '16px';
    const render = (DeckGLMap.prototype as unknown as { getTooltip(info: unknown): { html: string } }).getTooltip;
    tooltip.innerHTML = render.call({}, { layer: { id: 'renewable-installations-layer' }, object: {
      name: value, type: value, capacityMW: value, country: 'Test feed', year: 2026,
    } }).html;
    document.body.append(tooltip);
  }, hostile);
  await expect(page.locator('.liquidity-report-date')).toContainText(hostile);
  await expect(page.locator('#feed-tooltip-fixture')).toContainText(hostile);
  await expect(page.locator('#feed-tooltip-fixture .deckgl-tooltip')).toBeVisible();
  await expect(page.locator('img,script[src="x"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('hostile-feed-text.png'), fullPage: true });
});
