import { expect, test } from '@playwright/test';

/**
 * Theme toggle E2E tests for the happy variant.
 *
 * Tests run against the dev server started by the webServer config
 * (VITE_SITE_VARIANT=happy on port 4173).
 */

test.describe('theme toggle (happy variant)', () => {
  test.beforeEach(async ({ page }) => {
    // Set variant to happy, clear theme preference ONLY on first load
    // (addInitScript runs on every navigation, so we use a flag)
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('__test_init_done')) {
        localStorage.removeItem('worldmonitor-theme');
        localStorage.removeItem('worldmonitor-variant');
        localStorage.setItem('worldmonitor-variant', 'happy');
        sessionStorage.setItem('__test_init_done', '1');
      }
    });
  });

  test('happy variant defaults to light theme', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('light');

    // Background should be light
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    expect(bg).toBe('#FAFAF5'); // happy light bg
  });

  test('toggle to dark mode changes CSS variables', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    // Start in light mode
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    // Click theme toggle
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(200); // let theme-changed event propagate

    // Should now be dark
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('dark');

    // Background should be dark navy
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    expect(bg).toBe('#1A2332'); // happy dark bg

    // Text should be warm off-white
    const text = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    );
    expect(text).toBe('#E8E4DC'); // happy dark text
  });

  test('toggle back to light mode restores light CSS variables', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    // Toggle to dark
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    // Toggle back to light
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(200);

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('light');

    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    expect(bg).toBe('#FAFAF5'); // happy light bg
  });

  test('dark mode persists across page reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    // Toggle to dark
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    // Verify localStorage has 'dark'
    const stored = await page.evaluate(() => localStorage.getItem('worldmonitor-theme'));
    expect(stored).toBe('dark');

    // Reload the page
    await page.reload();
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    // Should still be dark after reload
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('dark');

    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );
    expect(bg).toBe('#1A2332'); // happy dark bg, NOT #FAFAF5
  });

  test('theme toggle icon updates correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#headerThemeToggle', { timeout: 15000 });

    // In light mode, icon should be moon (dark mode switch)
    const lightIcon = await page.locator('#headerThemeToggle svg path').count();
    // Moon icon has a <path>, sun icon has <circle> + <line> elements
    const hasMoon = lightIcon > 0;
    expect(hasMoon).toBe(true);

    // Toggle to dark
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(200);

    // In dark mode, icon should be sun (light mode switch)
    const hasSun = await page.locator('#headerThemeToggle svg circle').count();
    expect(hasSun).toBeGreaterThan(0);
  });

  test('panel backgrounds update on theme toggle', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.panel', { timeout: 20000 });

    // Get panel bg in light mode
    const lightPanelBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--panel-bg').trim(),
    );
    expect(lightPanelBg).toBe('#FFFFFF');

    // Toggle to dark
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(300);

    // Panel bg should change
    const darkPanelBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--panel-bg').trim(),
    );
    expect(darkPanelBg).toBe('#222E3E'); // happy dark panel bg
  });

  test('no FOUC: data-theme is set before main CSS loads', async ({ page }) => {
    // Set dark preference before navigation
    await page.addInitScript(() => {
      localStorage.setItem('worldmonitor-theme', 'dark');
      localStorage.setItem('worldmonitor-variant', 'happy');
    });

    await page.goto('/');

    // The inline script should set data-theme="dark" before CSS loads
    // Measure the data-theme immediately after navigation
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('dark');
  });

  test('screenshot comparison: light vs dark', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.panel', { timeout: 20000 });
    await page.waitForTimeout(2000); // let panels render

    // Screenshot in light mode
    await page.screenshot({ path: '/tmp/happy-light.png', fullPage: false });

    // Toggle to dark
    await page.click('#headerThemeToggle');
    await page.waitForTimeout(1000);

    // Screenshot in dark mode
    await page.screenshot({ path: '/tmp/happy-dark.png', fullPage: false });
  });
});
