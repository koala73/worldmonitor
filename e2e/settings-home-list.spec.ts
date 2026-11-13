import { devices, expect, test, type Page } from '@playwright/test';

// Settings opens on a grouped list of sections. Each row opens one page and
// the header's back button returns to the list. On a phone every row must fit
// the sheet without sideways scrolling, in left-to-right and Arabic layouts.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
void defaultBrowserType;
const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function seed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('mobile-map-collapsed');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

async function openSettingsFromMore(page: Page, query = ''): Promise<void> {
  await page.goto(`/dashboard${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
  await page.locator('[data-mobile-tab="more"]').click();
  await page.locator('#mobileMenuSettings').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
}

// Rows whose box spills past the modal's left or right edge, in px.
function rowsOutsideModal(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const modal = document.querySelector<HTMLElement>('.unified-settings-modal')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('[data-settings-home] button')]
      .map((row) => {
        const box = row.getBoundingClientRect();
        const out = Math.round(Math.max(0, modal.left - box.left) + Math.max(0, box.right - modal.right));
        return { label: row.textContent!.trim().replace(/\s+/g, ' '), out };
      })
      .filter((row) => row.out > 0)
      .map((row) => `${row.label} (${row.out}px)`);
  });
}

for (const width of [393, 360]) {
  for (const lang of ['', '?lang=ar']) {
    test.describe(`settings home on a ${width}px phone${lang ? ' in Arabic' : ''}`, () => {
      test.use({ ...pixel, viewport: { width, height: 852 } });

      test('every row fits the sheet without sideways scrolling', async ({ page }, testInfo) => {
        await seed(page);
        await openSettingsFromMore(page, lang);
        const modal = page.locator('.unified-settings-modal');
        await expect(page.locator('[data-settings-home]')).toBeVisible();
        await modal.screenshot({ path: testInfo.outputPath(`settings-home-${width}${lang ? '-ar' : ''}.png`) });
        expect(await page.locator('[data-settings-nav]').count(), 'the list has rows').toBeGreaterThan(8);
        expect(await rowsOutsideModal(page), 'rows cut off by the sheet edge').toEqual([]);
        const overflow = await modal.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(overflow, 'the sheet does not scroll sideways').toBeLessThanOrEqual(0);
      });
    });
  }
}

test.describe('settings navigation on a phone', () => {
  test.use({ ...pixel, viewport: { width: 393, height: 852 } });

  test('back returns to the list with focus on the row, and a reopen starts on the list', async ({ page }) => {
    await seed(page);
    await openSettingsFromMore(page);
    const row = page.locator('[data-settings-nav="about"]');
    await row.click();
    await expect(page.locator('#us-page-about')).toBeVisible();
    await expect(page.locator('[data-settings-home]')).toBeHidden();
    await expect(page.locator('#us-page-about .legal-links-row a').first()).toBeVisible();

    await page.locator('[data-settings-back]').click();
    await expect(page.locator('[data-settings-home]')).toBeVisible();
    await expect(row).toBeFocused();

    await row.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#unifiedSettingsModal')).not.toHaveClass(/active/);
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    await expect(page.locator('[data-settings-home]')).toBeVisible();
  });

  test('a deep link opens straight onto its page', async ({ page }) => {
    await seed(page);
    await page.goto('/dashboard?settings=notifications', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#us-page-notifications')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-settings-back]')).toBeVisible();
    await expect(page.locator('[data-settings-home]')).toBeHidden();
  });
});

test.describe('settings navigation on a desktop', () => {
  test.use(DESKTOP);

  test('a theme change on Display shows in the Display row', async ({ page }) => {
    await seed(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#unifiedSettingsBtn')).toBeVisible({ timeout: 60_000 });
    await page.locator('#unifiedSettingsBtn').click();
    await expect(page.locator('[data-settings-home]')).toBeVisible();

    await page.locator('[data-settings-nav="display"]').click();
    await page.locator('#us-theme label', { hasText: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('[data-settings-back]').click();
    await expect(page.locator('[data-settings-nav="display"] [data-settings-summary]')).toHaveText('Light');
  });
});

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 600 }, { width: 844, height: 390 }]) {
  test.describe(`compact Settings at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test('clears the phone navigation and reaches the last About link', async ({ page }) => {
      await seed(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
      if (viewport.width <= 768) {
        await page.locator('[data-mobile-tab="more"]').tap();
        await page.locator('#mobileMenuSettings').tap();
      } else {
        await page.locator('#unifiedSettingsBtn').tap();
      }
      const modal = page.locator('.unified-settings-modal');
      await expect(modal).toBeVisible();
      if (viewport.width <= 768) {
        const nav = await page.locator('#mobileTabBar').boundingBox();
        const box = await modal.boundingBox();
        expect(box!.y + box!.height, 'Settings clears the phone navigation').toBeLessThanOrEqual(nav!.y);
      }
      expect(await rowsOutsideModal(page), 'rows cut off by the sheet edge').toEqual([]);

      await page.locator('[data-settings-nav="about"]').tap();
      const lastLink = page.locator('#us-page-about .legal-links-row a').last();
      await lastLink.scrollIntoViewIfNeeded();
      await expect(lastLink).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });
  });
}
