import { expect, test, type Page } from '@playwright/test';

async function mountPanel(page: Page): Promise<void> {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { ServiceStatusPanel } = await import('/src/components/ServiceStatusPanel.ts');
    const panel = new ServiceStatusPanel();
    const host = document.getElementById('runtime-harness')!;
    host.textContent = '';
    host.style.cssText = 'max-width:720px;margin:32px auto;padding:16px';
    host.appendChild(panel.getElement());
    await panel.fetchStatus();
  });
}

for (const { label, width, height } of [
  { label: 'desktop', width: 1280, height: 720 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`ServiceStatusPanel renders 503 failure and healthy recovery on ${label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.clock.install();
    let available = false;
    await page.route('**/api/infrastructure/v1/list-service-statuses*', async (route) => {
      if (!available) {
        await route.fulfill({ status: 503, json: { error: 'Controlled required-seed outage' } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          statuses: [{
            id: 'github',
            name: 'GitHub',
            status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',
            description: 'All systems operational',
          }],
        },
      });
    });

    await mountPanel(page);
    const panel = page.locator('[data-panel="service-status"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-error-state')).toBeVisible();
    await expect(panel.locator('.panel-error-msg')).toContainText('Temporarily unavailable');
    await expect(panel.locator('.panel-error-countdown')).toContainText(/retrying/i);
    const failedPath = testInfo.outputPath(`service-status-${label}-503.png`);
    await panel.screenshot({ path: failedPath, animations: 'disabled' });
    await testInfo.attach(`service-status-${label}-503`, { path: failedPath, contentType: 'image/png' });

    available = true;
    await page.clock.fastForward(15_000);
    await expect(panel.locator('.panel-error-state')).toHaveCount(0);
    await expect(panel.locator('.service-status-item.operational')).toContainText('GitHub');
    await expect(panel.locator('.all-operational')).toContainText('All services operational');
    const recoveredPath = testInfo.outputPath(`service-status-${label}-recovered.png`);
    await panel.screenshot({ path: recoveredPath, animations: 'disabled' });
    await testInfo.attach(`service-status-${label}-recovered`, { path: recoveredPath, contentType: 'image/png' });
  });
}
