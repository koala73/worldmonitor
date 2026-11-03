import { devices, expect, test, type Page } from '@playwright/test';

// On a phone the Settings tab strip is wider than the modal and scrolls
// sideways with its scrollbar hidden. Without a cue nothing shows that more
// tabs sit past the edge, and a tab selected out of view stays hidden. The
// strip uses the same scroll-driven edge fade as panel tables.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
void defaultBrowserType;
const PHONE = { ...pixel, viewport: { width: 393, height: 852 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

interface Cue { start: string; end: string; mask: string }
interface Strip {
  overflow: number;
  atStart: Cue;
  atEnd: Cue;
}

async function seed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('mobile-map-collapsed');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

async function openSettingsFromMore(page: Page): Promise<void> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 60_000 });
  await page.locator('[data-mobile-tab="more"]').click();
  await page.locator('#mobileMenuSettings').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
}

// The fade follows a scroll timeline, so each read waits two frames for it
// to catch up with the new scroll position.
function readStrip(page: Page): Promise<Strip> {
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const strip = document.querySelector<HTMLElement>('#unifiedSettingsModal [role="tablist"]')!;
    const read = (): Cue => {
      const cs = getComputedStyle(strip);
      return {
        start: cs.getPropertyValue('--table-scroll-fade-start').trim(),
        end: cs.getPropertyValue('--table-scroll-fade-end').trim(),
        mask: cs.maskImage,
      };
    };
    strip.scrollLeft = 0;
    await frame();
    const atStart = read();
    strip.scrollLeft = strip.scrollWidth;
    await frame();
    const atEnd = read();
    strip.scrollLeft = 0;
    await frame();
    return { overflow: strip.scrollWidth - strip.clientWidth, atStart, atEnd };
  });
}

// How far the selected tab reaches under a faded or clipped edge of the
// strip, in px. 0 means the whole tab is in the clear part of the strip.
function selectedTabHidden(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const strip = document.querySelector<HTMLElement>('#unifiedSettingsModal [role="tablist"]')!;
    const tab = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    const cs = getComputedStyle(strip);
    const fadeStart = parseFloat(cs.getPropertyValue('--table-scroll-fade-start')) || 0;
    const fadeEnd = parseFloat(cs.getPropertyValue('--table-scroll-fade-end')) || 0;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    return Math.round(Math.max(0, s.left + fadeStart - t.left) + Math.max(0, t.right - (s.right - fadeEnd)));
  });
}

test.describe('settings tabs on a phone', () => {
  test.use(PHONE);

  test('the tab strip fades the edge that has more tabs', async ({ page }, testInfo) => {
    await seed(page);
    await openSettingsFromMore(page);
    const strip = page.locator('#unifiedSettingsModal [role="tablist"]');
    await strip.screenshot({ path: testInfo.outputPath('settings-tabs-393-start.png') });
    const s = await readStrip(page);
    expect(s.overflow, 'the tab strip is wider than a 393px modal').toBeGreaterThan(0);
    expect.soft(s.atStart.mask, 'an edge fade shows at the start').not.toBe('none');
    expect.soft(s.atStart, 'at the start only the trailing edge fades').toMatchObject({ start: '0px', end: '24px' });
    expect.soft(s.atEnd, 'at the end only the leading edge fades').toMatchObject({ start: '24px', end: '0px' });
  });

  test('a tab selected past the edge scrolls into the clear part of the strip', async ({ page }) => {
    await seed(page);
    await openSettingsFromMore(page);
    const strip = page.locator('#unifiedSettingsModal [role="tablist"]');
    const tabs = strip.locator('[role="tab"]');
    const cutOff = await tabs.evaluateAll((els) => {
      const right = els[0]!.parentElement!.getBoundingClientRect().right;
      return els.findIndex((el) => el.getBoundingClientRect().right > right + 1);
    });
    expect(cutOff, 'a tab runs past the right edge').toBeGreaterThan(0);
    await tabs.nth(cutOff).click();
    await expect(tabs.nth(cutOff)).toHaveAttribute('aria-selected', 'true');
    expect.soft(await selectedTabHidden(page), 'clicked tab is fully in view').toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('#unifiedSettingsModal')).not.toHaveClass(/active/);
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
    await expect(tabs.nth(cutOff)).toHaveAttribute('aria-selected', 'true');
    expect.soft(await selectedTabHidden(page), 'the tab selected before closing is in view on reopen').toBe(0);
  });

  test('a deep link to a later tab opens with that tab in view', async ({ page }, testInfo) => {
    await seed(page);
    await page.goto('/dashboard?settings=notifications', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#us-tab-notifications')).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
    await page.locator('#unifiedSettingsModal [role="tablist"]').screenshot({ path: testInfo.outputPath('settings-tabs-393-notifications.png') });
    expect(await selectedTabHidden(page), 'Notifications tab is fully in view').toBe(0);
  });
});

test.describe('settings tabs on a desktop', () => {
  test.use(DESKTOP);

  test('the tab strip shows no fade when every tab fits', async ({ page }) => {
    await seed(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#unifiedSettingsBtn')).toBeVisible({ timeout: 60_000 });
    await page.locator('#unifiedSettingsBtn').click();
    await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
    const s = await readStrip(page);
    expect(s.overflow, 'every tab fits a desktop modal').toBeLessThanOrEqual(0);
    expect(s.atStart.mask, 'no edge fade when nothing is hidden').toBe('none');
  });
});
