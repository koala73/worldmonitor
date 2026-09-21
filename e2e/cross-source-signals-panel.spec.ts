import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`shows unknown detection time without hiding a signal at width ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async () => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { CrossSourceSignalsPanel } = await import('/src/components/CrossSourceSignalsPanel.ts');
      const panel = new CrossSourceSignalsPanel();
      const host = document.getElementById('runtime-harness')!;
      host.textContent = '';
      host.style.cssText = 'max-width:640px;margin:24px auto;padding:12px';
      host.appendChild(panel.getElement());
      const signal = {
        id: 'missing-time', type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE', theater: 'Global Markets',
        summary: 'Synthetic cached signal with unavailable detection time.',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH', severityScore: 70,
        detectedAt: 0, contributingTypes: [], signalCount: 1,
      };
      panel.setData({
        signals: [
          null as never,
          false as never,
          ...[0, undefined, Number.NaN, Number.POSITIVE_INFINITY].map((detectedAt, index) => ({
            ...signal, id: `unknown-time-${index}`, detectedAt,
          })),
          { ...signal, id: 'known-time', summary: 'Synthetic cached signal with a known detection time.', detectedAt: Date.now() - 5 * 60_000 },
        ],
        evaluatedAt: 0,
        compositeCount: 0,
      });
    });
    const panel = page.locator('[data-panel="cross-source-signals"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Synthetic cached signal with unavailable detection time.');
    await panel.screenshot({ path: testInfo.outputPath('panel.png') });
    await expect(panel).toContainText('time unknown');
    await expect(panel.getByText(/Global Markets.*time unknown/)).toHaveCount(4);
    await expect(panel).toContainText('5m ago');
    await expect(panel).not.toContainText(/\d{5,}h ago|just now/);
  });
}
