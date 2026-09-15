import { test, expect } from '@playwright/test';

test('liquidity report dates stay text and missing data stays unavailable', async ({ page }, testInfo) => {
  let reportDate = '<b data-cot-injected>bad & "date"</b>';
  let available = true;
  await page.route('**/api/market/v1/get-cot-positioning*', route => route.fulfill({
    json: { reportDate, unavailable: !available, instruments: available ? [{
      name: 'Gold', code: 'GC', reportDate, assetManagerLong: '300', assetManagerShort: '200',
    }] : [] },
  }));
  await page.route('**/api/market/v1/list-market-quotes*', route => route.fulfill({ json: { quotes: [] } }));
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves source modules in the browser.
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    // @ts-expect-error Vite serves production styles in the browser.
    await import('/src/styles/main.css');
  });
  const render = () => page.evaluate(async () => {
    // @ts-expect-error Vite serves the real panel; RPC responses are controlled above.
    const { LiquidityShiftsPanel } = await import('/src/components/LiquidityShiftsPanel.ts');
    const panel = new LiquidityShiftsPanel();
    document.body.replaceChildren(panel.getElement());
    panel.getElement().style.cssText = 'width: min(600px, 100%); min-height: 300px; margin: 24px auto';
    return panel.fetchData();
  });
  expect(await render()).toBe(true);
  const footer = page.locator('.liquidity-report-date');
  await expect(footer).toHaveText(`COT report date: ${reportDate}`);
  await expect(page.locator('[data-cot-injected]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('malformed-date.png') });
  reportDate = '2026-08-04';
  expect(await render()).toBe(true);
  await expect(footer).toHaveText('COT report date: 2026-08-04');
  await page.screenshot({ path: testInfo.outputPath('valid-date.png') });
  reportDate = '';
  expect(await render()).toBe(true);
  await expect(footer).toHaveCount(0);
  await expect(page.locator('.liquidity-row')).toHaveCount(1);
  available = false;
  expect(await render()).toBe(false);
  await expect(footer).toHaveCount(0);
  await expect(page.locator('.panel')).toContainText('unavailable');
});
