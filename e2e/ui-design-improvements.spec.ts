import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page, theme: string): Promise<void> {
  await page.addInitScript((selectedTheme) => {
    if (sessionStorage.getItem('ui-design-seeded')) return;
    localStorage.clear();
    sessionStorage.setItem('ui-design-seeded', '1');
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-theme', selectedTheme);
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  }, theme);
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  await page.route(url => /^https?:$/.test(url.protocol) && url.origin !== origin, route => route.abort());
  await page.goto('/dashboard');
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function openSettings(page: Page, mobile: boolean): Promise<void> {
  if (mobile) await page.locator('[data-mobile-tab="more"]').click();
  await page.locator(mobile ? '#mobileMenuSettings' : '#unifiedSettingsBtn').click();
}

for (const theme of ['light', 'dark']) {
  for (const width of [320, 393, 1440]) {
    test(`${theme} controls fit at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await boot(page, theme);
      const mobile = width <= 768;
      await page.locator(mobile ? '[data-mobile-tab="search"]' : '#searchBtn').click();
      const tips = page.locator('.search-launch-grid');
      await expect(tips).toBeVisible();
      await expect.poll(() => tips.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      if (mobile) {
        const close = await page.locator('.search-sheet-cancel').boundingBox();
        const input = await page.locator('.search-input').boundingBox();
        expect(close!.width).toBeGreaterThanOrEqual(44);
        expect(close!.height).toBeGreaterThanOrEqual(44);
        expect(input!.x + input!.width).toBeLessThanOrEqual(close!.x);
        await expect(page.locator('.search-chip')).toHaveCount(2);
      }
      await page.locator('button[data-search-scope="actions"]').click();
      await expect(page.locator('button[data-search-scope="actions"]')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await openSettings(page, mobile);
      await page.locator('#us-tab-sources').click();
      const sources = page.locator('.sources-toggle-grid');
      await expect.poll(() => sources.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      if (mobile) {
        expect((await page.locator('.source-toggle-item').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await page.locator('.unified-settings-close').boundingBox())!.width).toBeGreaterThanOrEqual(44);
      }
      await page.locator('#us-tab-panels').click();
      const disclosure = page.locator('.panel-font-scale-details').first();
      await expect(disclosure.locator('select')).not.toBeVisible();
      await disclosure.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(disclosure.locator('select')).toBeVisible();
      await expect(page.locator('[data-panel="map"] + details')).toHaveCount(0);
      await page.locator('#us-tab-notifications').click();
      await expect(page.locator('#usNotifUpgradeBtn')).toHaveText('Sign In');
      await page.locator('#us-tab-api-keys').click();
      await expect(page.locator('#us-tab-panel-api-keys .settings-access-gate h3')).toHaveText('API and desktop keys');
      await page.locator('#us-tab-settings').click();
      await page.locator('summary').filter({ hasText: 'Analysis Frameworks' }).click();
      await page.locator('#fwImportBtn').click();
      const field = page.getByLabel('agentskills.io URL or ID', { exact: true });
      await expect(field).toBeVisible();
      const colors = await field.evaluate(el => {
        const style = getComputedStyle(el);
        return { border: style.borderTopColor, background: style.backgroundColor };
      });
      expect(colors.border).not.toBe(colors.background);
      await page.locator('#fwTabJson').click();
      await expect(page.locator('#fwJsonInput')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.fw-import-modal')).not.toBeVisible();
      await expect(page.locator('#unifiedSettingsModal')).toBeVisible();
      await expect(page.locator('#fwImportBtn')).toBeFocused();
      await page.locator('#fwImportBtn').click();
      await expect(page.locator('#fwJsonInput')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.fw-import-modal')).not.toBeVisible();
      await expect(page.locator('#unifiedSettingsModal')).toBeVisible();
      await expect(page.locator('#fwImportBtn')).toBeFocused();
      await page.locator('.unified-settings-close').click();
      await page.goto('/dashboard?c=UA');
      const more = page.locator('.cdp-more-actions > summary');
      await expect(more).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create story', exact: true })).not.toBeVisible();
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Create story', exact: true })).toBeVisible();
      await expect(page.locator('.cdp-evidence-export-btn')).toBeVisible();
    });
  }
}

for (const theme of ['light', 'dark']) {
  test(`${theme} narrow settings fit at enlarged text size`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await boot(page, theme);
    await openSettings(page, true);
    await page.locator('#us-font-scale').selectOption('2');
    await page.locator('#us-tab-sources').click();
    await expect.poll(() => page.locator('.sources-toggle-grid').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await page.locator('#us-tab-panels').click();
    await page.locator('.panel-font-scale-details > summary').first().click();
    const panel = page.locator('.panel-font-scale-details').first();
    await expect.poll(() => panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await page.locator('.unified-settings-close').click();
    await page.locator('[data-mobile-tab="search"]').click();
    await expect(page.locator('.search-launch-grid')).toBeVisible();
    await expect.poll(() => page.locator('.search-launch-grid').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  });
}
