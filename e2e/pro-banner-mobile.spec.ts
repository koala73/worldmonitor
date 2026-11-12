import { readFileSync, readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Conversion audit item 10 (2026-11-06): on phones the free-user Pro strip
// read "Pro is launched — More Signal, Less Nois…", which names nothing a
// visitor gets. The strip now leads with one concrete Pro feature, and on
// narrow screens that line must be readable in full inside the 40px slot the
// pre-paint script reserves (a taller strip would shift the dashboard).

const HEADLINE = 'Daily AI briefs by email or Slack';
const SLOT_HEIGHT = 40;

async function openFreeDashboard(page: Page, path = '/'): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.removeItem('wm-pro-banner-launched-dismissed');
    localStorage.removeItem('wm-entitlement-hint');
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.locator('.pro-banner.pro-banner-in').waitFor({ timeout: 20000 });
}

async function bannerLayout(page: Page) {
  return page.locator('.pro-banner').evaluate((banner) => {
    const text = banner.querySelector<HTMLElement>('.pro-banner-text')!;
    const headline = text.querySelector<HTMLElement>('strong')!;
    const tagline = banner.querySelector<HTMLElement>('.pro-banner-tagline');
    const cta = banner.querySelector<HTMLElement>('.pro-banner-cta')!.getBoundingClientRect();
    const visible = (el: HTMLElement | null) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    return {
      headline: headline.textContent?.trim(),
      headlineClipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
      taglineVisible: visible(tagline),
      height: banner.getBoundingClientRect().height,
      ctaRight: cta.right,
      viewport: window.innerWidth,
    };
  });
}

for (const width of [360, 390]) {
  test.describe(`Pro strip at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

    test('names a concrete Pro feature in full, inside the reserved slot', async ({ page }) => {
      await openFreeDashboard(page);
      const layout = await bannerLayout(page);
      expect(layout.headline).toBe(HEADLINE);
      expect(layout.headlineClipped, 'headline must not be cut off').toBe(false);
      expect(layout.taglineVisible, 'the tagline is desktop-only').toBe(false);
      expect(layout.height).toBeLessThanOrEqual(SLOT_HEIGHT);
      expect(layout.ctaRight).toBeLessThanOrEqual(layout.viewport);
    });
  });
}

// Every language must fit too: the headline is the whole message on a phone.
const LOCALE_DIR = new URL('../src/locales/', import.meta.url);
const localeHeadlines = readdirSync(LOCALE_DIR)
  .filter((file) => file.endsWith('.json') && !file.endsWith('.shell.json'))
  .map((file) => {
    const dict = JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8'));
    return { lang: file.replace(/\.json$/, ''), headline: dict.components.proBanner.headline as string };
  });

test.describe('Pro strip at 360px in every language', () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  for (const { lang, headline } of localeHeadlines) {
    test(`${lang} headline fits in full`, async ({ page }) => {
      await openFreeDashboard(page, `/?lang=${lang}`);
      await expect(page.locator('.pro-banner-text strong')).toHaveText(headline);
      const layout = await bannerLayout(page);
      expect(layout.headlineClipped, `${lang}: "${headline}" is cut off`).toBe(false);
      expect(layout.height).toBeLessThanOrEqual(SLOT_HEIGHT);
      expect(layout.ctaRight).toBeLessThanOrEqual(layout.viewport);
    });
  }
});

test.describe('Pro strip on desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the headline and the tagline on one line', async ({ page }) => {
    await openFreeDashboard(page);
    const layout = await bannerLayout(page);
    expect(layout.headline).toBe(HEADLINE);
    expect(layout.taglineVisible).toBe(true);
    expect(layout.headlineClipped).toBe(false);
    expect(layout.height).toBeLessThanOrEqual(SLOT_HEIGHT);
  });

  // Banner views were counted (gate-hit feature=pro-banner) but clicks were
  // not, so the strip's click-through could not be measured. The click must
  // be recorded even when the analytics tracker has not loaded, and must not
  // hold up the navigation to /pro.
  test('records a click without delaying the navigation to /pro', async ({ page }) => {
    await page.route(/abacus\.worldmonitor\.app/, (route) => route.abort());
    await openFreeDashboard(page);
    const started = Date.now();
    await page.locator('.pro-banner-cta').click();
    await page.waitForURL(/\/pro#pricing$/, { timeout: 3000 });
    expect(Date.now() - started).toBeLessThan(3000);
    const pending = await page.evaluate(() => sessionStorage.getItem('wm-conversion-pending'));
    expect(JSON.parse(pending ?? '[]')).toContainEqual({ event: 'pro-banner-click', data: { state: 'upgrade' } });
  });
});

// The strip's gradient is translucent. In the light theme the page body
// behind it stayed near-black while the headline turned dark grey, so the
// headline was unreadable; the strip needs its own themed background.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`Pro strip in the ${colorScheme} theme`, () => {
    test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, colorScheme });

    test('the headline has readable contrast', async ({ page }) => {
      await openFreeDashboard(page);
      const { background, ratio } = await page.locator('.pro-banner').evaluate((banner) => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = ([r, g, b]: number[]) => {
          const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        };
        const bg = rgb(getComputedStyle(banner).backgroundColor);
        const fg = rgb(getComputedStyle(banner.querySelector('strong')!).color);
        const [hi, lo] = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
        return { background: bg, ratio: (hi! + 0.05) / (lo! + 0.05) };
      });
      expect(background[3] ?? 1, 'strip background must be opaque').toBe(1);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  });
}
