import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// A grid item's default `min-width: auto` resolves to its content's
// min-content width. The /pro API section's curl sample is one long unbroken
// line inside a <pre>, so without `min-w-0` on the grid items both tracks grew
// to ~783px, the `overflow-x-auto` wrapper never got a narrower box to scroll
// in, and a 390px phone laid the whole page out 807px wide with the nav's
// Sign In / Upgrade buttons off-screen (#9174).
//
// Translations hit the same failure with single long words: Russian's
// "Пользовательский" for the custom tier price is wider at text-4xl than its
// card, so the ru case pins the price wrapping too.
//
// The overflow only exists after React mounts, so this drives the built
// bundle rather than the crawlable prerender markup.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-mobile-overflow.test';
const PRO_INDEX = 'public/pro/index.html';

const CASES = [
  { width: 360, lang: 'en' },
  { width: 390, lang: 'en' },
  { width: 412, lang: 'en' },
  { width: 360, lang: 'ru' },
];

for (const { width, lang } of CASES) {
  test.describe(`/pro fits a ${width}px phone after mount (${lang})`, () => {
    // isMobile honours the viewport meta tag and stretches the layout
    // viewport to the widest content, which is how phones rendered the 807px
    // page zoomed out. A resized desktop context never does either.
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test('no horizontal overflow', async ({ page }) => {
      // public/pro/ is gitignored build output. Fail with the fix rather than
      // with an opaque net::ERR_FAILED from aborting the document request.
      expect(
        existsSync(resolve(repoRoot, PRO_INDEX)),
        `${PRO_INDEX} is missing. Run \`npm run build:pro\` first.`,
      ).toBe(true);

      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        const pathname = url.pathname === '/pro' ? '/pro/index.html' : url.pathname;
        const path = resolve(repoRoot, 'public', pathname.replace(/^\//, ''));
        if (!existsSync(path)) return route.abort();
        return route.fulfill({ path });
      });
      await page.goto(`${ORIGIN}/pro?lang=${lang}`, { waitUntil: 'load' });

      // The API section is React-only markup; waiting on it proves the mount
      // happened, so a pass is not just the narrower prerender block.
      const apiSample = page.locator('#api pre');
      await expect(apiSample).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);

      const layout = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(layout.innerWidth, `/pro layout viewport is not the ${width}px phone width`).toBe(width);
      expect(layout.scrollWidth, `/pro overflows a ${width}px viewport`).toBe(layout.clientWidth);

      // The long curl line must scroll inside its own box instead.
      const sampleBox = await page.locator('#api .overflow-x-auto').evaluate((el) => ({
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }));
      expect(sampleBox.clientWidth).toBeLessThanOrEqual(width);
      expect(sampleBox.scrollWidth).toBeGreaterThan(sampleBox.clientWidth);

      // The nav CTAs the overflow pushed off-screen must sit inside the viewport.
      const navRight = await page.locator('nav').first().evaluate((nav) => Math.max(
        ...Array.from(nav.querySelectorAll('a, button'))
          .map((el) => el.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => rect.right),
      ));
      expect(navRight).toBeLessThanOrEqual(width);
    });
  });
}
