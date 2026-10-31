import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// The landing nav must hold its logo, menu button and Launch button on one
// row in every language the page ships, at phone and desktop widths.
//
// Nine inline links once pushed Launch off-screen in 16 locales on a 1536px
// desktop (French needed ~1474px against the 1280px container), and the
// phone row overflowed in French and Vietnamese at 360px, where there was
// no menu at all. The labels only exist after React mounts with `?lang=`,
// so this drives the built bundle rather than the prerender markup. The
// page-overflow check also holds the live-data cards, whose German badge
// once widened the page past a 320px phone.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://welcome-nav-fit.test';
const WELCOME = 'public/pro/welcome.html';
const LOCALES = readdirSync(resolve(repoRoot, 'pro-test/src/locales'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''));

const GROUPS = [
  // isMobile honours the viewport meta tag, so page-level overflow shows up
  // as a wider layout viewport, the way a phone renders it.
  { name: 'phone', widths: [320, 360, 390], isMobile: true },
  { name: 'desktop', widths: [1024, 1280, 1536], isMobile: false },
];

async function serveBuiltSite(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const path = resolve(repoRoot, 'public', url.pathname.replace(/^\//, ''));
    if (!existsSync(path)) return route.abort();
    return route.fulfill({ path });
  });
}

function measureNav() {
  const nav = document.querySelector('nav[data-wm-nav]')!;
  const row = nav.firstElementChild!;
  const rowStyle = getComputedStyle(row);
  // Measure along the inline axis so Arabic and Persian, which lay the row
  // out right to left, are held to the same rules.
  const rtl = rowStyle.direction === 'rtl';
  const span = (el: Element) => {
    const r = el.getBoundingClientRect();
    return rtl ? { start: -r.right, end: -r.left, height: r.height, width: r.width } : { start: r.left, end: r.right, height: r.height, width: r.width };
  };
  const rowBox = span(row);
  const contentStart = rowBox.start + parseFloat(rowStyle.paddingInlineStart);
  const contentEnd = rowBox.end - parseFloat(rowStyle.paddingInlineEnd);
  const logo = span(nav.querySelector('a')!);
  const menu = span(nav.querySelector('summary')!);
  const launchEl = nav.querySelector<HTMLElement>('a[data-umami-event-target="welcome-nav"]')!;
  const launch = span(launchEl);
  return {
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    launchPastEdge: Math.round(launch.end - contentEnd),
    launchHeight: launch.height,
    launchClipped: launchEl.scrollWidth > launchEl.clientWidth + 1,
    logoHeight: logo.height,
    logoPastEdge: Math.round(contentStart - logo.start),
    menuWidth: menu.width,
    menuOverlapsLogo: menu.start < logo.end,
    launchOverlapsMenu: launch.start < menu.end,
  };
}

for (const group of GROUPS) {
  test.describe(`welcome nav fits ${group.name} widths in every locale`, () => {
    test.use({ viewport: { width: group.widths[0], height: 800 }, isMobile: group.isMobile, hasTouch: group.isMobile });

    for (const lang of LOCALES) {
      test(lang, async ({ page }) => {
        expect(existsSync(resolve(repoRoot, WELCOME)), `${WELCOME} is missing. Run \`npm run build:pro\` first.`).toBe(true);
        await serveBuiltSite(page);
        await page.goto(`${ORIGIN}/pro/welcome.html?lang=${lang}`, { waitUntil: 'load' });
        // The mounted app sets the document language; waiting on it proves
        // the nav carries the translated labels, not the English prerender.
        // (`zh` mounts as `zh-CN`.)
        await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${lang}(-|$)`));

        for (const width of group.widths) {
          await page.setViewportSize({ width, height: 800 });
          const m = await page.evaluate(measureNav);
          const at = `${lang} at ${width}px`;
          expect(m.pageOverflow, `${at}: page scrolls sideways`).toBeLessThanOrEqual(0);
          expect(m.launchPastEdge, `${at}: Launch crosses the row edge`).toBeLessThanOrEqual(0);
          expect(m.launchClipped, `${at}: Launch label is clipped`).toBe(false);
          // Two text lines plus padding fit the 64px row; a third does not.
          expect(m.launchHeight, `${at}: Launch wraps past two lines`).toBeLessThanOrEqual(48);
          expect(m.logoHeight, `${at}: logo wraps`).toBeLessThanOrEqual(32);
          expect(m.logoPastEdge, `${at}: logo is squeezed past the row edge`).toBeLessThanOrEqual(0);
          expect(m.menuWidth, `${at}: menu button is missing`).toBeGreaterThan(0);
          expect(m.menuOverlapsLogo, `${at}: menu button overlaps the logo`).toBe(false);
          expect(m.launchOverlapsMenu, `${at}: Launch overlaps the menu button`).toBe(false);
        }
      });
    }
  });
}
