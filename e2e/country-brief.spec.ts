import type { Page, TestInfo } from '@playwright/test';
import { test, expect, HYDRATED_MARKET } from './country-brief-fixtures';

test.use({ trace: 'on', serviceWorkers: 'block' });

function marketsCard(page: Page) {
  return page.locator('#country-deep-dive-panel .cdp-card').filter({
    has: page.getByRole('heading', { name: 'Prediction Markets', exact: true }),
  });
}

async function expectCountry(page: Page) {
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.cdp-country-name')).toHaveText('Ukraine');
  await expect(panel.locator('.cdp-country-name')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBe('UA');
}

async function expectMarkets(page: Page) {
  const card = marketsCard(page);
  await expect(card.locator('.cdp-market-title')).toHaveText([
    'Ukraine QA ceasefire agreement?', 'Ukraine QA reconstruction funding?',
  ]);
  await expect(card.locator('.cdp-market-prob')).toHaveText(['Probability: 67%', 'Probability: 38%']);
  await expect(card.locator('.prediction-source')).toHaveText(['Polymarket', 'Kalshi']);
  await expect(card.locator('.cdp-market-link').nth(0)).toHaveAttribute('href', 'https://polymarket.com/event/qa-ua-ceasefire');
  await expect(card.locator('.cdp-market-link').nth(1)).toHaveAttribute('href', 'https://kalshi.com/markets/qa-ua-funding');
  await expect(card.locator('.cdp-loading-inline, .cdp-empty')).toHaveCount(0);
  await expect(card.locator('.cdp-market-item').nth(0)).toBeVisible();
  await expect(card.locator('.cdp-market-item').nth(1)).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await marketsCard(page).scrollIntoViewIfNeeded();
  await marketsCard(page).evaluate(card => card.scrollIntoView({ block: 'center' }));
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('country brief renders exact RPC records and preserves the country after reload', async ({ page, countryBrief }, testInfo) => {
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'rpc-before-reload');

  const requestsBeforeReload = countryBrief.requests.length;
  if (countryBrief.fault === 'drop-reload-country') {
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.delete('country');
      history.replaceState(null, '', url);
    });
  }
  await page.reload();
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests.length).toBeGreaterThan(requestsBeforeReload);
  expect(countryBrief.requests.every(request => request.category === 'country:UA' && request.status === 200)).toBe(true);
  await screenshot(page, testInfo, 'rpc-after-reload');
});

test('country brief uses bootstrap fallback when the country index is unavailable', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: false, fetchedAt: 0 };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  const card = marketsCard(page);
  await expect(card.locator('.cdp-market-title')).toHaveText([HYDRATED_MARKET.title]);
  await expect(card.locator('.cdp-market-prob')).toHaveText(['Probability: 54%']);
  await expect(card.locator('.prediction-source')).toHaveText(['Polymarket']);
  await expect(card.locator('.cdp-market-link')).toHaveAttribute('href', HYDRATED_MARKET.url);
  await expect(card.locator('.cdp-market-item')).toBeVisible();
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'bootstrap-fallback');
});

test('country brief honors an authoritative empty index over bootstrap fallback', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expect(marketsCard(page).locator('.cdp-empty')).toHaveText('No active markets for this country.');
  await expect(marketsCard(page).locator('.cdp-market-item, .cdp-loading-inline')).toHaveCount(0);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'authoritative-empty');
});

test('country brief recovers from a failed RPC when the user reloads', async ({ page, countryBrief }, testInfo) => {
  countryBrief.status = 503;
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expect(marketsCard(page).locator('.cdp-empty')).toHaveText('No active markets for this country.');
  await expect(marketsCard(page).locator('.cdp-market-item, .cdp-loading-inline')).toHaveCount(0);
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 503 });
  await screenshot(page, testInfo, 'rpc-failure');

  countryBrief.status = 200;
  await page.reload();
  await expectCountry(page);
  await expectMarkets(page);
  expect(countryBrief.requests[countryBrief.requests.length - 1]).toEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'rpc-recovered');
});
