import { expect, test } from '@playwright/test';

// Exercises the real layout, responsive relocation and existing click handler.
test('dashboard names remain readable from tablet through desktop', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('switcher-profile-seeded')) return;
    sessionStorage.setItem('switcher-profile-seeded', '1');
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
  // Header navigation is independent of live data providers.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-wm-event-handlers-ready="true"]').waitFor();
  for (const width of [1375, 1920, 1876, 1875, 1831, 1830, 1731, 1730, 1631, 1630, 1536, 1501, 1440, 1376, 1366, 1280, 1201, 1180, 1076, 1075, 1000, 981, 980, 940, 834, 768, 767, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const switcher = page.locator('.variant-switcher');
    await expect(switcher).toHaveCount(1);
    if (width < 768) {
      await expect(switcher).toBeHidden();
      continue;
    }
    await expect(switcher).toBeVisible();
    if (width > 1075) await expect(page.locator('.mission-preset-button')).toBeVisible();
    await expect(page.locator(width <= 980 ? '.dashboard-navigation-row .variant-switcher' : '.header-left .variant-switcher')).toHaveCount(1);
    const labels = switcher.locator('.variant-label');
    await expect(labels).toHaveCount(6);
    for (const label of await labels.all()) {
      await expect(label).toBeVisible();
      await expect(label).toHaveCSS('opacity', '1');
      expect(await label.evaluate(el => el.clientWidth >= el.scrollWidth)).toBe(true);
    }
    const header = await page.locator('.header').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
    expect(header.content).toBeLessThanOrEqual(header.width + 1);
    if (width <= 980) {
      const last = switcher.locator('[data-variant="happy"]');
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
    }
    if ([834, 940, 1440].includes(width)) {
      await page.screenshot({ path: `test-results/dashboard-switcher-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.mission-preset-button').click();
  await expect(page.getByRole('dialog', { name: 'Mission presets', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Mission presets', exact: true })).toBeHidden();
  await page.setViewportSize({ width: 834, height: 900 });
  await page.locator('.variant-option[data-variant="tech"]').click();
  await expect(page.locator('.variant-option.active[data-variant="tech"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('worldmonitor-variant'))).toBe('tech');
});
