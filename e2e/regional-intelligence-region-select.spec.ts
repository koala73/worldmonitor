import { expect, test } from '@playwright/test';

// The Regional Intelligence region picker had a class no stylesheet styled, so
// it rendered as the browser's white system dropdown in both themes and was 19px
// tall on a phone. It must take the dashboard's region-picker look: the theme's
// background, text, and border tokens, the chevron, a keyboard focus ring, and a
// usable height (44px for touch).

const CASES = [
  { name: 'phone dark', viewport: { width: 393, height: 852 }, theme: 'dark', touch: true },
  { name: 'phone light', viewport: { width: 393, height: 852 }, theme: 'light', touch: true },
  { name: 'desktop dark', viewport: { width: 1366, height: 900 }, theme: 'dark', touch: false },
] as const;

for (const { name, viewport, theme, touch } of CASES) {
  test(`regional intelligence region picker matches the dashboard theme (${name})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('worldmonitor-variant', 'full');
      localStorage.setItem('worldmonitor-theme', selectedTheme);
      localStorage.setItem('wm-pro-key', 'e2e-regional-intelligence');
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      localStorage.setItem('worldmonitor-panels', JSON.stringify({
        'regional-intelligence': { name: 'Regional Intelligence', enabled: true, priority: 0 },
      }));
    }, theme);
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const panel = page.locator('[data-panel="regional-intelligence"]').first();
    await panel.scrollIntoViewIfNeeded();
    const select = page.locator('.panel[data-panel="regional-intelligence"]').getByLabel('Region', { exact: true });
    await select.scrollIntoViewIfNeeded();
    await expect(select).toBeVisible();

    const look = await select.evaluate((el) => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--bg);color:var(--text);border:1px solid var(--border)';
      el.parentElement!.appendChild(probe);
      const tokens = getComputedStyle(probe);
      const expected = { bg: tokens.backgroundColor, text: tokens.color, border: tokens.borderTopColor };
      probe.remove();
      const cs = getComputedStyle(el);
      return {
        expected,
        actual: { bg: cs.backgroundColor, text: cs.color, border: cs.borderTopColor },
        appearance: cs.appearance,
        chevron: cs.backgroundImage.includes('svg'),
        height: el.getBoundingClientRect().height,
      };
    });
    expect(look.actual, 'picker uses the theme background, text, and border').toEqual(look.expected);
    expect(look.actual.bg, 'picker is not the browser white dropdown').not.toBe('rgb(255, 255, 255)');
    expect(look.appearance).toBe('none');
    expect(look.chevron, 'picker keeps a dropdown chevron').toBe(true);
    expect(look.height, 'picker is a usable tap target').toBeGreaterThanOrEqual(touch ? 44 : 32);

    await page.keyboard.press('Tab');
    await select.focus();
    const ring = await select.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.visible).toBe(true);
    expect(ring.style, 'keyboard focus draws a ring').not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);

    await context.close();
  });
}
