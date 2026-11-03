import { expect, test } from '@playwright/test';

test('keeps cards through a failed request and reload, then renders confirmed empty', async ({ page }, testInfo) => {
  await page.clock.install();
  await page.goto('/tests/correlation-panel-harness.html');
  const economic = page.locator('[data-panel="economic-correlation"]');
  const escalation = page.locator('[data-panel="escalation-correlation"]');
  await expect(economic).toContainText('Energy trade restrictions');
  await expect(escalation).toContainText('No active convergence detected');
  await expect(page.locator('#requests')).toHaveText('1');

  await page.getByRole('button', { name: 'Fail data request', exact: true }).click();
  await expect(economic).toContainText('Last known update');
  await expect(economic).toContainText('Energy trade restrictions');
  await expect(page.locator('.panel-error-state, .panel-error-countdown, .panel-header-error')).toHaveCount(0);
  await economic.locator('.correlation-card-header').click();
  await expect(economic).toContainText('Synthetic sanctions announcement');
  const mapButton = economic.getByRole('button', { name: 'View on map' });
  await mapButton.focus();
  const originalButton = await mapButton.elementHandle();
  await page.clock.fastForward(60_000);
  await expect(mapButton).toBeFocused();
  expect(await originalButton!.evaluate(button => button.isConnected)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('retained-cards-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Reload with saved data', exact: true }).click();
  await expect(economic).toContainText('Energy trade restrictions');
  await expect(economic).toContainText('Last known update');
  await expect(page.locator('#fixture-state')).toHaveText('failure');
  await expect(page.locator('.panel-error-state, .panel-error-countdown, .panel-header-error')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(economic).toBeVisible();
  expect(await economic.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('retained-after-reload-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: 'Confirmed empty response', exact: true }).click();
  await expect(economic).toContainText('No active convergence detected');
  await expect(economic).not.toContainText('Energy trade restrictions');
  await expect(economic.locator('.panel-count')).toHaveText('0');
  await expect(page.locator('.panel-error-state, .panel-error-countdown, .panel-header-error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('confirmed-empty-mobile.png'), fullPage: true });
});

test('recovers through a false offline hint without a reconnect event', async ({ page }, testInfo) => {
  await page.clock.install();
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.goto('/tests/correlation-panel-harness.html');
  const economic = page.locator('[data-panel="economic-correlation"]');
  await expect(economic).toContainText('Waiting for a connection');
  await expect(economic.locator('.panel-count')).toBeHidden();
  await expect(page.locator('#requests')).toHaveText('0');
  await page.screenshot({ path: testInfo.outputPath('offline-first-visit-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.clock.fastForward(60_000);
  await expect(economic).toContainText('Energy trade restrictions');
  await expect(economic.locator('.correlation-status')).toContainText('Updated');
  await expect(page.locator('#requests')).toHaveText('1');
  await expect(page.locator('.panel-error-state, .panel-error-countdown, .panel-header-error')).toHaveCount(0);
});

test('waits quietly on a failed first visit and recovers without a reload', async ({ page }, testInfo) => {
  await page.addInitScript(() => sessionStorage.setItem('correlation-fixture-mode', 'failure'));
  await page.goto('/tests/correlation-panel-harness.html');
  const economic = page.locator('[data-panel="economic-correlation"]');
  await expect(economic).toContainText('Waiting for the next data update');
  await expect(economic.locator('.panel-count')).toBeHidden();
  await expect(economic).not.toContainText('No active convergence detected');
  await expect(page.locator('.panel-error-state, .panel-error-countdown, .panel-header-error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('first-visit-waiting-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Healthy response', exact: true }).click();
  await expect(economic).toContainText('Energy trade restrictions');
  await expect(economic.locator('.panel-count')).toHaveText('1');
});
