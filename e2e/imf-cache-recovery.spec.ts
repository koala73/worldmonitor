import { expect, test } from '@playwright/test';

for (const { label, width, height } of [
  { label: 'desktop', width: 1280, height: 720 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`World inflation retains healthy macro data during a partial IMF load on ${label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/consumer-prices/**', route => route.fulfill({ status: 503, json: { message: 'Controlled retail outage' } }));
    await page.route('**/api/bootstrap?**', route => {
      const params = new URL(route.request().url()).searchParams;
      const key = params.get('keys')!;
      expect(params.get('public')).toBe('1');
      if (key === 'imfLabor') return route.fulfill({ status: 503, json: { message: 'Controlled labor outage' } });
      const countries = key === 'imfMacro' ? { AE: { inflationPct: 2, cpiEopPct: 2.1, year: 2026 } } : {};
      return route.fulfill({ json: { data: { [key]: { countries } } } });
    });

    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async () => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { ConsumerPricesPanel } = await import('/src/components/ConsumerPricesPanel.ts');
      const panel = new ConsumerPricesPanel();
      const host = document.getElementById('runtime-harness')!;
      host.style.cssText = 'max-width:720px;margin:32px auto;padding:16px';
      host.appendChild(panel.getElement());
      await panel.fetchData();
    });
    const panel = page.locator('[data-panel="consumer-prices"]');
    await panel.locator('[data-tab="world"]').click();
    const row = panel.locator('.cp-world-table tbody tr').filter({ hasText: 'United Arab Emirates' });
    await expect(row).toContainText('+2.0%');
    await expect(row).toContainText('2026');
    const screenshot = testInfo.outputPath(`imf-partial-${label}.png`);
    await panel.screenshot({ path: screenshot, animations: 'disabled' });
    await testInfo.attach(`imf-partial-${label}`, { path: screenshot, contentType: 'image/png' });
  });
}
