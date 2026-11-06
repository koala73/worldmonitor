import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Every dashboard "Upgrade to Pro" CTA links to /pro#pricing (#10171). The
// pricing section is React-only markup, absent from the prerendered /pro
// HTML, so the browser's native fragment scroll can run before the target
// exists and leave the buyer at the top of a ~20,000px page. In production a
// click from the dashboard landed at scrollY 0 with #pricing 9,706px below.
//
// This drives the built bundle, like pro-mobile-overflow.spec.ts.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-pricing-anchor.test';
const PRO_INDEX = 'public/pro/index.html';
const FROM_PAGE = '/__from-dashboard.html';

async function serveBuiltPro(page: Page) {
  expect(
    existsSync(resolve(repoRoot, PRO_INDEX)),
    `${PRO_INDEX} is missing. Run \`npm run build:pro\` first.`,
  ).toBe(true);

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === FROM_PAGE) {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><a id="upgrade" href="/pro#pricing">Upgrade to Pro</a>',
      });
    }
    const pathname = url.pathname === '/pro' ? '/pro/index.html' : url.pathname;
    const path = resolve(repoRoot, 'public', pathname.replace(/^\//, ''));
    if (!existsSync(path)) return route.abort();
    return route.fulfill({ path });
  });
}

async function expectPricingInView(page: Page) {
  const pricing = page.locator('section#pricing');
  await expect(pricing).toBeAttached();
  // Poll: the fix scrolls once the section mounts, which can follow `load`.
  await expect
    .poll(async () => pricing.evaluate((el) => Math.round(el.getBoundingClientRect().top)), {
      message: '#pricing should be scrolled to the top of the viewport',
      timeout: 5_000,
    })
    .toBeLessThanOrEqual(80);
  // Late layout above the section (images, fonts) must not push it away again.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
  const top = await pricing.evaluate((el) => el.getBoundingClientRect().top);
  expect(top, '#pricing drifted after the page settled').toBeGreaterThanOrEqual(-80);
  expect(top, '#pricing drifted after the page settled').toBeLessThanOrEqual(80);
}

test.describe('/pro#pricing lands on the pricing section', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('direct load', async ({ page }) => {
    await serveBuiltPro(page);
    await page.goto(`${ORIGIN}/pro#pricing`, { waitUntil: 'load' });
    await expectPricingInView(page);
  });

  test('link click from another page (the dashboard CTA path)', async ({ page }) => {
    await serveBuiltPro(page);
    await page.goto(`${ORIGIN}${FROM_PAGE}`);
    await page.click('#upgrade');
    await page.waitForURL(`${ORIGIN}/pro#pricing`);
    await expectPricingInView(page);
  });

  test('a plain /pro load stays at the top', async ({ page }) => {
    await serveBuiltPro(page);
    await page.goto(`${ORIGIN}/pro`, { waitUntil: 'load' });
    await expect(page.locator('section#pricing')).toBeAttached();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('/pro#pricing lands on the pricing section on a phone', () => {
  // isMobile applies the viewport meta tag and mobile scaling, which a
  // resized desktop context never does (see pro-mobile-overflow.spec.ts).
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('link tap from another page', async ({ page }) => {
    await serveBuiltPro(page);
    await page.goto(`${ORIGIN}${FROM_PAGE}`);
    await page.tap('#upgrade');
    await page.waitForURL(`${ORIGIN}/pro#pricing`);
    await expectPricingInView(page);
  });
});
