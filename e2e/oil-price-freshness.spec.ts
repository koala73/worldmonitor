import { expect, test } from '@playwright/test';

// Real panel rendering with fixed source dates and clocks. No live feed or cache.
for (const scenario of [
  { name: 'EIA Christmas release delay', now: '2025-12-29T21:59Z', week: '2025-12-12', stale: false },
  { name: 'EIA missed normal release', now: '2026-11-19T23:59Z', week: '2026-11-06', stale: true },
  { name: 'futures Christmas weekend', now: '2026-12-26T12:00Z', quote: '2026-12-24T18:44Z', stale: false },
]) {
  test(scenario.name, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(scenario.now));
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async (state) => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { EnergyComplexPanel } = await import('/src/components/EnergyComplexPanel.ts');
      document.getElementById('runtime-harness')?.remove();
      const label = document.createElement('p');
      label.textContent = `Fixture: ${state.name} · Clock: ${state.now} UTC`;
      label.style.cssText = 'padding:16px;color:var(--text-primary)';
      document.body.appendChild(label);
      const panel = new EnergyComplexPanel();
      panel.getElement().style.cssText = 'width:min(700px,calc(100vw - 32px));min-width:0;height:auto;margin:16px';
      document.body.appendChild(panel.getElement());
      if (state.week) {
        panel.updateAnalytics({
          wtiPrice: { id: 'wti', name: 'WTI', description: '', current: 85, previous: 84,
            changePct: 1.2, unit: '$/bbl', trend: 'up', lastUpdated: state.week },
          brentPrice: null, usProduction: null, usInventory: null, fetchedAt: new Date(),
        });
      } else {
        panel.updateTape([{ symbol: 'CL=F', name: 'WTI', display: 'WTI', price: 85, change: 1.2,
          priceBasis: 'futures', priceSource: 'Yahoo Finance', priceAt: Date.parse(state.quote!) }]);
      }
    }, scenario);
    const panel = page.locator('.panel[data-panel="energy-complex"]');
    await expect(panel).toBeVisible();
    if (scenario.stale) await expect(panel).toContainText('Stale');
    else await expect(panel).not.toContainText('Stale');
    await expect(panel).toContainText(scenario.week ?? '2026-12-24');
    await page.screenshot({ path: testInfo.outputPath('desktop.png') });
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(panel).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mobile.png') });
  });
}
