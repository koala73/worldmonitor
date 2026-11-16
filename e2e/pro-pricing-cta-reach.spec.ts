import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Buyers landing on /pro#pricing had to scroll past whole feature lists to
// reach a checkout button: 1,626px down on a 390x844 phone (Free first, then
// the Pro card's features) and 1,351px down on a 1440x900 laptop (#10843).
// The CTA now sits under the price, and the highlighted tier leads on phones.
//
// This drives the built bundle, like pro-pricing-anchor.spec.ts.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://pro-pricing-cta-reach.test';
const PRO_INDEX = 'public/pro/index.html';
const PAID_PLANS = ['pro', 'proBusiness', 'api', 'apiBusiness'];

async function serveBuiltPro(page: Page) {
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
}

async function landOnPricing(page: Page) {
  await serveBuiltPro(page);
  await page.goto(`${ORIGIN}/pro#pricing`, { waitUntil: 'load' });
  const pricing = page.locator('section#pricing');
  await expect
    .poll(async () => pricing.evaluate((el) => Math.round(el.getBoundingClientRect().top)), {
      message: '#pricing should be scrolled to the top of the viewport',
      timeout: 5_000,
    })
    .toBeLessThanOrEqual(80);
  await page.waitForLoadState('networkidle');
  // Card entrance animations translate each card by up to 30px.
  await page.waitForTimeout(1_000);
  const landingTop = await pricing.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(landingTop, '#pricing must not scroll past the viewport top').toBeGreaterThanOrEqual(0);
}

async function visibleButtonRect(page: Page, plan: string) {
  const button = checkoutButton(page, plan);
  await expect(button, `#plan-${plan} checkout button`).toBeVisible();
  const rect = await button.evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  });
  expect(rect.top, `#plan-${plan} checkout button must not sit above the viewport`).toBeGreaterThanOrEqual(0);
  return rect;
}

function checkoutButton(page: Page, plan: string) {
  return page.locator(`#plan-${plan} button`);
}

async function expectConsentDirectlyAboveEveryButton(page: Page) {
  for (const plan of PAID_PLANS) {
    const button = checkoutButton(page, plan);
    await expect(button).toHaveCount(1);
    // #6976: the assent line must immediately precede every checkout button.
    const previous = await button.evaluate((el) => el.previousElementSibling?.getAttribute('data-checkout-consent'));
    expect(previous, `#plan-${plan} checkout button must follow the consent line`).toBe('');
  }
}

test.describe('/pro#pricing checkout reach on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the Pro checkout button is within one screen of the landing point', async ({ page }) => {
    await landOnPricing(page);
    const { bottom } = await visibleButtonRect(page, 'pro');
    const innerHeight = await page.evaluate(() => window.innerHeight);
    expect(bottom, 'Pro checkout button bottom vs viewport height').toBeLessThanOrEqual(innerHeight);
    await expectConsentDirectlyAboveEveryButton(page);
  });
});

test.describe('/pro#pricing checkout reach on a laptop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every paid checkout button is above the fold', async ({ page }) => {
    await landOnPricing(page);
    for (const plan of PAID_PLANS) {
      const { top } = await visibleButtonRect(page, plan);
      expect(top, `#plan-${plan} checkout button top`).toBeLessThan(900);
    }
    await expectConsentDirectlyAboveEveryButton(page);
  });
});
