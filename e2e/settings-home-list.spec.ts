import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';

// Settings is one grouped list of sections. On a phone it opens on that list,
// each row opens one page, and the header's back button returns to the list;
// every row must fit the sheet without sideways scrolling, in left-to-right
// and Arabic layouts. Wider screens show the list as a searchable sidebar
// beside the selected page, over the dimmed dashboard.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
void defaultBrowserType;

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

async function openSettingsFromGear(page: Page, query = ''): Promise<void> {
  await page.goto(`/dashboard${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
  if (!query) await page.locator('#unifiedSettingsBtn').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
}

const currentRow = (page: Page) => page.locator('#unifiedSettingsModal [aria-current="page"]');
const sidebarRows = (page: Page) => page.locator('[data-settings-rows] [data-settings-nav], [data-settings-rows] [data-settings-signin]');

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test.describe(`settings sidebar at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('opens on Display and moves between pages from the sidebar', async ({ page }, testInfo) => {
      await seed(page);
      await openSettingsFromGear(page);
      const sheet = page.locator('.unified-settings-modal');

      await expect(page.locator('#us-page-display')).toBeVisible();
      await expect(currentRow(page)).toHaveAttribute('data-settings-nav', 'display');
      await expect(page.locator('[data-settings-home]')).toBeVisible();
      await expect(page.locator('[data-settings-back]')).toBeHidden();
      const box = (await sheet.boundingBox())!;
      expect(box.width, 'the sheet is 960px wide or the viewport less its gutters').toBe(Math.min(960, viewport.width - 32));
      await sheet.screenshot({ path: testInfo.outputPath(`settings-sidebar-${viewport.width}.png`) });

      for (const id of ['panels', 'sources', 'api-keys', 'about']) {
        await page.locator(`[data-settings-nav="${id}"]`).click();
        await expect(page.locator(`#us-page-${id}`)).toBeVisible();
        await expect(currentRow(page)).toHaveAttribute('data-settings-nav', id);
        await expect(page.locator(`[data-settings-nav="${id}"]`)).toBeFocused();
      }
      await expect(page.locator('#us-page-display')).toBeHidden();
      expect(await rowsOutsideModal(page), 'rows cut off by the sheet edge').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'nothing scrolls sideways').toBe(0);

      await page.keyboard.press('Escape');
      await page.locator('#unifiedSettingsBtn').click();
      await expect(page.locator('#us-page-about'), 'a reopen returns to the page selected last').toBeVisible();
    });

    test('searches the sidebar, says when nothing matches, and Escape clears before it closes', async ({ page }) => {
      await seed(page);
      await openSettingsFromGear(page);
      const search = page.locator('[data-settings-search]');
      const empty = page.locator('[data-settings-empty]');

      await search.fill('privacy');
      await expect(sidebarRows(page)).toHaveCount(2);
      await expect(page.locator('[data-settings-rows] [data-settings-signin]')).toBeVisible();
      await expect(page.locator('[data-settings-nav="about"]')).toBeVisible();
      await expect(empty).toBeHidden();

      await search.fill('zzz');
      await expect(sidebarRows(page)).toHaveCount(1);
      await expect(empty).toHaveText('No settings match');

      await search.press('Escape');
      await expect(search).toHaveValue('');
      await expect(page.locator('[data-settings-nav="about"]')).toBeVisible();
      await expect(empty).toBeHidden();
      await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);

      await search.press('Escape');
      await expect(page.locator('#unifiedSettingsModal')).not.toHaveClass(/active/);
    });

    test('a deep link selects its page in the sidebar', async ({ page }) => {
      await seed(page);
      await openSettingsFromGear(page, '?settings=notifications');
      await expect(page.locator('#us-page-notifications')).toBeVisible({ timeout: 60_000 });
      await expect(currentRow(page)).toHaveAttribute('data-settings-nav', 'notifications');
      await expect(page.locator('[data-settings-home]')).toBeVisible();
    });

    test('shows the dashboard dimmed behind the sheet', async ({ page }) => {
      await seed(page);
      await openSettingsFromGear(page);
      const scrim = await page.locator('#unifiedSettingsModal').evaluate((el) => {
        const match = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/)!;
        const parts = match[1]!.split(',').map((part) => Number.parseFloat(part));
        return parts.length === 4 ? parts[3]! : 1;
      });
      expect(scrim, 'the backdrop is translucent').toBeGreaterThan(0.2);
      expect(scrim, 'the backdrop is translucent').toBeLessThan(0.7);
      const hit = await page.evaluate(() => document.elementFromPoint(8, window.innerHeight / 2)?.id);
      expect(hit, 'the scrim still catches clicks beside the sheet').toBe('unifiedSettingsModal');
    });

    test('the open sheet passes axe', async ({ page }) => {
      test.setTimeout(180_000);
      await seed(page);
      await openSettingsFromGear(page);
      await expect(page.locator('#us-page-display')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include('#unifiedSettingsModal')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  });
}

test.describe('settings across the phone breakpoint', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a page open in the sidebar stays open on the phone sheet, and Back goes home', async ({ page }) => {
    await seed(page);
    await openSettingsFromGear(page);
    await page.locator('[data-settings-nav="map"]').click();
    await expect(page.locator('#us-page-map')).toBeVisible();

    await page.setViewportSize({ width: 393, height: 852 });
    await expect(page.locator('#us-page-map')).toBeVisible();
    await expect(page.locator('[data-settings-home]')).toBeHidden();
    await expect(page.locator('[data-settings-search]')).toBeHidden();

    await page.locator('[data-settings-back]').click();
    await expect(page.locator('[data-settings-home]')).toBeVisible();
    await expect(page.locator('#us-page-map')).toBeHidden();
  });

  test('the phone home list widens into the sidebar on Display', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await seed(page);
    await openSettingsFromMore(page);
    await expect(page.locator('[data-settings-home]')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#us-page-display')).toBeVisible();
    await expect(currentRow(page)).toHaveAttribute('data-settings-nav', 'display');
  });

  test('at 800px the sheet fits the window without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await seed(page);
    await openSettingsFromGear(page);
    await page.locator('[data-settings-nav="sources"]').click();
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>('.unified-settings-modal')!;
      const pane = document.querySelector<HTMLElement>('[data-settings-pages]')!;
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        sheet: sheet.scrollWidth - sheet.clientWidth,
        pane: pane.scrollWidth - pane.clientWidth,
      };
    });
    expect(overflow).toEqual({ page: 0, sheet: 0, pane: 0 });
    expect(await rowsOutsideModal(page)).toEqual([]);
  });
});

test.describe('Display segmented controls', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('arrow keys move the theme, and the sidebar row follows at once', async ({ page }) => {
    await seed(page);
    await openSettingsFromGear(page);
    const auto = page.locator('#us-theme input[value="auto"]');
    await expect(auto).toBeChecked();

    await auto.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#us-theme input[value="dark"]')).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#us-theme input[value="light"]')).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('[data-settings-nav="display"] [data-settings-summary]')).toHaveText('Light');

    await page.locator('#us-font-family label', { hasText: 'System Default' }).click();
    await expect(page.locator('#us-font-family input[value="system"]')).toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('wm-font-family'))).toBe('system');
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
