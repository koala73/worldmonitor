import type { Page, TestInfo } from '@playwright/test';
import { test, expect, HYDRATED_MARKET } from './country-brief-fixtures';
import { captureImfPeriods, type ImfPeriodScenario } from './country-brief-fixtures';
import { readFile, writeFile } from 'node:fs/promises';
import { installCountryBriefDesignData } from './country-brief-design-fixtures';
import type { CountrySignalOutcome } from '../shared/country-signal-observations';

const recording = process.env.CI ? 'on-first-retry' : 'retain-on-failure';

for (const [language, width, label] of [['fr', 1280, 'Débloquez 90 jours avec Pro'], ['ar', 390, 'افتح سجل 90 يومًا مع Pro']] as const) {
  test(`daily country history localizes ${language} at ${width}`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/intelligence/v1/get-country-history?*', route => route.fulfill({ json: {
      country: 'UA', requestedDays: 7, allowedDays: 7, effectiveDays: 7, returnedDays: 1,
      upstreamUnavailable: false, stale: false, fetchedAt: Date.now(),
      points: [{ date: '2026-10-19', capturedAt: Date.UTC(2026, 9, 19, 0, 30),
        cii: { score: 62, version: 'v11', observedAt: Date.UTC(2026, 9, 19) },
        resilience: { score: 47, version: 'v29:pc', observedAt: Date.UTC(2026, 9, 19) },
        topEvents: [], keySignals: [], ciiVersionBreak: false, resilienceVersionBreak: false }],
    } }));
    await page.goto(`/dashboard?country=UA&expanded=1&lang=${language}`);
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.locator('[data-topic="security"]').click();
    const history = page.locator('#cdp-section-history');
    await history.scrollIntoViewIfNeeded();
    await expect(history.locator('.panel-locked-cta')).toHaveText(label);
    expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(page.locator('html')).toHaveCSS('direction', language === 'ar' ? 'rtl' : 'ltr');
    const path = testInfo.outputPath(`history-${language}-${width}.png`);
    await history.screenshot({ path });
    await testInfo.attach(language, { path, contentType: 'image/png' });
  });
}

for (const width of [1280, 390]) {
  test(`daily country history ${width} preserves gaps, event click-through and failure recovery`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    await page.setViewportSize({ width, height: 900 });
    let unavailable = true;
    let reads = 0;
    await page.route('**/api/intelligence/v1/get-country-history?*', async route => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get('country')).toBe('UA');
      expect(params.get('days')).toBe('7');
      reads++;
      await route.fulfill({ json: {
        country: 'UA', requestedDays: 7, allowedDays: 7, effectiveDays: 7, returnedDays: 3,
        upstreamUnavailable: unavailable, stale: false, fetchedAt: Date.now(),
        points: [17, 18, 19].map((day, index) => ({
          date: `2026-10-${day}`, capturedAt: Date.UTC(2026, 9, day, 0, 30),
          cii: { score: 50 + index * 6, version: index === 2 ? 'v11' : 'v10', observedAt: Date.UTC(2026, 9, day) },
          resilience: { score: 45 + index, version: 'v29:pc', observedAt: Date.UTC(2026, 9, day) },
          topEvents: [{ title: `Controlled Ukraine reporting for October ${day}`, link: `https://example.com/ukraine-${day}`, source: 'Controlled publisher', category: 'politics' }],
          keySignals: [], ciiVersionBreak: index === 2, resilienceVersionBreak: false,
        })),
      } });
    });
    await page.goto('/dashboard?country=UA&expanded=1');
    await expectCountry(page);
    const openHistory = async () => {
      await page.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Security', exact: true }).click();
      await page.locator('#cdp-section-history').scrollIntoViewIfNeeded();
    };
    const captureHistory = async (state: string) => {
      const path = testInfo.outputPath(`history-${state}-${width}.png`);
      await page.locator('#cdp-section-history').screenshot({ path });
      await testInfo.attach(state, { path, contentType: 'image/png' });
    };
    await openHistory();
    const history = page.locator('#cdp-section-history');
    await expect(history).toContainText('History is temporarily unavailable');
    await captureHistory('unavailable');
    unavailable = false;
    await history.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(history.locator('a[href="https://example.com/ukraine-19"]')).toBeVisible();
    await expect(history).toContainText('Formula or observation gap');
    await expect(history.locator('.panel-locked-cta')).toHaveText('Unlock 90 days with Pro');
    await history.locator('svg circle.country-history-resilience').first().click();
    await expect(history.locator('.country-history-detail')).toContainText('2026-10-17');
    await expect(history.locator('a[href="https://example.com/ukraine-17"]')).toBeVisible();
    await expect(history.locator('a[href="https://example.com/ukraine-17"]')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await history.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await history.locator('[data-history-date="2026-10-19"]').click();
    await captureHistory('recovered');
    expect(reads).toBe(2);
    await page.reload();
    await expectCountry(page);
    await openHistory();
    await expect(history.locator('.country-history-detail')).toContainText('2026-10-19');
  });
}

for (const width of [1280, 390]) for (const addedIds of [0, 5]) {
  test(`mixed-source sanctions attribution ${addedIds} added IDs ${width}`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    await page.setViewportSize({ width, height: 900 });
    const title = `50 sanctions designations; ${addedIds} additions since prior snapshot`;
    const entries = Array.from({ length: 50 }, (_, index) => ({
      id: `${index < 25 ? 'SDN' : 'sema-ca'}:${index}`, name: `Controlled mixed-source entity ${index}`,
      sourceLists: [index < 25 ? 'SDN' : 'sema-ca'], programs: [],
      countryCodes: ['CN'], countryNames: ['China'], entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
      effectiveAt: '1577836800000', isNew: index >= 25 && index < 25 + addedIds,
    }));
    const sanctions = { entries, totalCount: 50, sdnCount: 25, consolidatedCount: 0,
      semaCount: 25, newEntryCount: addedIds, vesselCount: 0, aircraftCount: 0,
      countries: [{ countryCode: 'CN', countryName: 'China', entryCount: 50,
        newEntryCount: addedIds, vesselCount: 0, aircraftCount: 0 }], programs: [],
      fetchedAt: String(Date.now()), datasetDate: '1577836800000' };
    let reads = 0;
    let qualifiedReads = 0;
    await page.route('**/api/intelligence/v1/get-country-signal-observations?*', async route => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get('family') !== 'COUNTRY_SIGNAL_FAMILY_SANCTIONS') return route.fallback();
      expect(params.get('country_code')).toBe('CN');
      qualifiedReads++;
      const snapshotAt = new Date(Number(sanctions.fetchedAt)).toISOString();
      const outcome: CountrySignalOutcome = { countryCode: 'CN', family: 'sanctions', state: 'observed',
        observations: [{ id: 'CN:sanctions', family: 'sanctions', type: 'sanctions_pressure', severity: 'high',
          title, source: 'OFAC / Canada SEMA', eventAt: null, snapshotAt, timeBasis: 'snapshot' }],
        snapshotAt, retrievedAt: snapshotAt, computedAt: null, observationWindow: null,
        scope: 'Controlled country-coded sanctions observations', attribution: 'OFAC / Canada SEMA',
        partial: false, sampleBeforeCountryFilter: false, reason: null,
        matchedRows: 1, sampledRows: 1, omittedRows: 0 };
      await route.fulfill({ json: { countryCode: 'CN', family: 'COUNTRY_SIGNAL_FAMILY_SANCTIONS', windowIndex: 0,
        outcomeJson: JSON.stringify(outcome) } });
    });
    await page.route('**/api/bootstrap?*', async route => {
      const keys = new URL(route.request().url()).searchParams.get('keys') ?? '';
      if (!keys.split(',').includes('sanctionsPressure')) return route.fallback();
      reads++;
      await route.fulfill({ json: { data: { sanctionsPressure: sanctions }, missing: [] } });
    });
    await page.goto('/dashboard?layers=sanctions');
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-wm-initial-data-ready', 'true');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.locator(width < 768 ? '[data-mobile-tab="search"]' : '#searchBtn').click();
    await page.locator('.search-overlay .search-input').fill('China');
    await page.locator('.search-result-item[data-index]').filter({ hasText: 'Brief: China' }).click();
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel.locator('.cdp-country-name')).toHaveText('China');
    await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Security', exact: true }).click();
    const signals = panel.locator('#cdp-section-signals');
    await expect(signals).toContainText(title);
    await expect(signals).not.toContainText('Qualified country military observations are loading.');
    expect(qualifiedReads).toBeGreaterThan(0);
    await expect(signals.locator('.cdp-signal-item')).toContainText('OFAC / Canada SEMA');
    await expect(signals).not.toContainText('OFAC-linked');
    await expect(signals).not.toContainText('new OFAC');
    await signals.scrollIntoViewIfNeeded();
    await expect(signals.getByText(title, { exact: true })).toBeVisible();
    const clipped = await signals.getByText(title, { exact: true }).evaluate(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    expect(clipped).toBe(false);
    await signals.screenshot({ path: testInfo.outputPath(`controlled-mixed-source-${addedIds}-added-${width}-signals.png`) });
    await page.screenshot({ path: testInfo.outputPath(`controlled-mixed-source-${addedIds}-added-${width}-viewport.png`) });
    await writeFile(testInfo.outputPath('sanctions-fixture.json'), JSON.stringify({ mode: 'controlled mixed OFAC / Canada SEMA through qualified RPC', addedIds, width, entries, title, reads, qualifiedReads }, null, 2));
  });
}

for (const width of [1280, 390]) for (const scenario of ['mixed', 'legacy', 'partial', 'sparse'] as ImfPeriodScenario[]) {
  test(`IMF annual website ${scenario} ${width}`, async ({ page, countryBrief }, testInfo) => {
    countryBrief.imfScenario = scenario;
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard?country=CA&expanded=1');
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.getByRole('button', { name: 'Economy & trade', exact: true }).click();
    await captureImfPeriods(page, panel.locator('[data-brief-section=economic]'), scenario, testInfo, 'website');
    if (scenario === 'mixed') {
      await expect(panel.locator('[data-brief-section=economic] .cdp-economic-label')).toHaveText(['Stock Index', 'Weekly Momentum', 'Instability Regime', 'Real GDP Growth', 'CPI Inflation', 'Unemployment']);
    }
  });
}
test.use({ trace: recording, video: recording, serviceWorkers: 'block' });

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
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Economy & trade', exact: true }).click();
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

test('country shortcut keeps the dashboard canonical and shares a working dashboard URL', async ({ page, context, countryBrief }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/dashboard?c=UA');
  const countryName = page.locator('#country-deep-dive-panel .cdp-country-name');
  await expect(countryName).toHaveText('Ukraine');
  await expect(countryName).toBeVisible();
  await page.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await expectMarkets(page);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://www.worldmonitor.app/dashboard');
  await page.locator('#country-deep-dive-panel .cdp-share-btn').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL('/dashboard?c=UA', page.url()).href);
  const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(countryBrief.requests.length).toBeGreaterThan(0);
  for (const [name, width, height] of [['desktop', 1280, 720], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('#country-deep-dive-panel .cdp-country-name').scrollIntoViewIfNeeded();
    const path = testInfo.outputPath(`country-shortcut-${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`country-shortcut-${name}`, { path, contentType: 'image/png' });
  }
  await page.goto(sharedUrl);
  await expect(countryName).toHaveText('Ukraine');
  await expect(countryName).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/dashboard');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://www.worldmonitor.app/dashboard');
});

test('country brief renders exact RPC records and preserves the country after reload', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response.fetchedAt = Date.parse('2026-10-09T07:41:45.410Z');
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expectMarkets(page);
  await expect(marketsCard(page).locator('.cdp-section-source')).toHaveText('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
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
  await expect(marketsCard(page).locator('.cdp-section-source')).toHaveText('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
  expect(countryBrief.requests.length).toBeGreaterThan(requestsBeforeReload);
  expect(countryBrief.requests.every(request => request.category === 'country:UA' && request.status === 200)).toBe(true);
  await screenshot(page, testInfo, 'rpc-after-reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, 'website-clock-known-mobile');
});

test('country brief uses bootstrap fallback when the country index is unavailable', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: false, fetchedAt: Date.parse('2026-10-09T07:41:45.410Z') };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  const card = marketsCard(page);
  await expect(card.locator('.cdp-market-title')).toHaveText([HYDRATED_MARKET.title]);
  await expect(card.locator('.cdp-market-prob')).toHaveText(['Probability: 54%']);
  await expect(card.locator('.prediction-source')).toHaveText(['Polymarket']);
  await expect(card.locator('.cdp-market-link')).toHaveAttribute('href', HYDRATED_MARKET.url);
  await expect(card.locator('.cdp-market-item')).toBeVisible();
  await expect(card.locator('.cdp-section-source')).toHaveText('Snapshot time unavailable. Quote times are not supplied.');
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'bootstrap-fallback');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, 'website-clock-fallback-mobile');
});

test('country brief honors an authoritative empty index over bootstrap fallback', async ({ page, countryBrief }, testInfo) => {
  countryBrief.hydrate = true;
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: Date.parse('2026-10-09T07:41:45.410Z') };
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  await expect(marketsCard(page).locator('.cdp-empty')).toHaveText('No active markets for this country.');
  await expect(marketsCard(page).locator('.cdp-market-item, .cdp-loading-inline')).toHaveCount(0);
  await expect(marketsCard(page).locator('.cdp-section-source')).toHaveText('Market data snapshot: 2026-10-09T07:41:45.410Z. This time applies to the list. Quote times are not supplied.');
  expect(countryBrief.requests).toContainEqual({ method: 'GET', category: 'country:UA', pageSize: '5', status: 200 });
  await screenshot(page, testInfo, 'authoritative-empty');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, 'website-clock-empty-mobile');
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

// The brief panel is a lazy chunk (#4382). When it arrived after the deep
// link's single debounced URL write, that write ran with no visible brief and
// dropped ?country, and nothing rewrote it: the panel's state listener was
// registered before the panel existed. Slow CI runners hit this as a flake.
test('a country deep link keeps ?country when the brief chunk loads slowly, and closing drops it', async ({ page, countryBrief }) => {
  void countryBrief;
  // A later map move can rewrite the URL with the country once the brief is
  // visible, which hides the drop; so check every write, not the final URL.
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { __wmUrlWrites: string[] }).__wmUrlWrites = writes;
    const replaceState = history.replaceState.bind(history);
    history.replaceState = (state, unused, url) => {
      writes.push(String(url ?? location.href));
      replaceState(state, unused, url);
    };
  });
  // The chunk arrives after the first URL write; the signals arrive after
  // showLoading(), which opens the panel under the placeholder `__loading__`.
  for (const [module, delayMs] of [['CountryDeepDivePanel', 3000], ['signal-aggregator', 6000]] as const) {
    await page.route(`**/src/**/${module}.ts*`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.continue();
    });
  }
  await page.goto('/dashboard?country=UA');
  await expectCountry(page);
  const writes = await page.evaluate(() => (window as unknown as { __wmUrlWrites: string[] }).__wmUrlWrites);
  expect(writes.length).toBeGreaterThan(0);
  for (const url of writes) expect(new URL(url, page.url()).searchParams.get('country'), url).toBe('UA');
  await page.locator('#deep-dive-close').click();
  await expect(page.locator('#country-deep-dive-panel')).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBeNull();
});

test('a country deep link whose brief chunk fails to load drops ?country', async ({ page, countryBrief }) => {
  void countryBrief;
  await page.route('**/src/components/CountryDeepDivePanel.ts*', (route) => route.abort());
  await page.goto('/dashboard?country=UA');
  await expect(page.getByText('Country brief failed to open. Please try again.')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBeNull();
});

test('a search deep link that also names a country opens search and keeps no pending ?country', async ({ page, countryBrief }) => {
  void countryBrief;
  await page.goto('/dashboard?q=ukraine&country=UA');
  await expect(page.locator('.search-modal')).toBeVisible();
  await expect(page.locator('#country-deep-dive-panel.active')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBeNull();
});

test('US brief keeps late evidence, metric design and report data connected', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  const data = await installCountryBriefDesignData(page);
  await page.goto('/dashboard?country=US&expanded=1');
  const panel = page.locator('#country-deep-dive-panel');
  const topic = (name: string) => panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name, exact: true });
  await expect(panel.locator('.cdp-country-name')).toHaveText('United States');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('aria-busy', 'true');
  await topic('Economy & trade').click();
  // Release while the real request is still live; unrelated metric checks can exceed its deadline on CI.
  data.releaseFactors();
  await expect(panel.locator('#cdp-section-factors').getByRole('tab', { includeHidden: true })).toHaveCount(5);
  const housing = panel.locator('#cdp-section-housing');
  await expect(housing.locator('.cdp-metric-hero')).toHaveText(['156.4', '186.6', '8.0']);
  await expect(housing).toContainText('-2.1% · ↓ Falling');
  await expect(housing).toContainText('BIS · 2026-Q1');
  await expect(panel.locator('#cdp-section-debt .cdp-metric-hero')).toHaveText('128.6%');
  await expect(panel.locator('#cdp-section-debt')).toContainText('source value needs review');
  await expect(panel.locator('#cdp-section-tariffs')).toContainText('→ Unchanged');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('aria-busy', 'false');
  await expect(topic('Economy & trade')).toHaveAttribute('aria-current', 'page');
  await housing.scrollIntoViewIfNeeded();
  await testInfo.attach('housing-desktop', { body: await page.screenshot({ path: testInfo.outputPath('housing-desktop.png') }), contentType: 'image/png' });
  await topic('Overview').click();
  const factors = panel.locator('#cdp-section-factors');
  await expect(factors.getByRole('tab')).toHaveCount(5);
  await expect(factors.locator('.cdp-scorecard-score')).toHaveText(['5/5', '4/5', '4/5', '5/5', '5/5']);
  await factors.getByRole('tab', { name: /Food/ }).focus();
  await page.keyboard.press('End');
  await expect(factors.getByRole('tab', { name: /Defense/ })).toBeFocused();
  await expect(factors.getByRole('tabpanel', { name: /Defense/ })).toContainText('65% coverage');
  await expect(factors.getByRole('tabpanel', { name: /Defense/ })).toContainText('Arms supplier diversity');
  await expect(factors.locator('.cdp-scorecard-input')).toHaveCount(27);
  await expect(panel.locator('#cdp-section-assessment .cdp-summary-only').first()).toContainText('The United States has attacked three Iranian oil tankers');
  await expect(panel.locator('#cdp-section-assessment .cdp-summary-only').first()).not.toContainText('Classification:');
  await factors.scrollIntoViewIfNeeded();
  await testInfo.attach('factors-desktop', { body: await page.screenshot({ path: testInfo.outputPath('factors-desktop.png') }), contentType: 'image/png' });
  let releaseOutput: () => void = () => {};
  let outputRequested = false;
  const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
  await page.route('**/src/components/CountryBriefOutput.ts*', async route => {
    outputRequested = true;
    await outputReady;
    await route.continue();
  });
  await panel.getByRole('button', { name: 'Export report ↗', exact: true }).click();
  await expect.poll(() => outputRequested).toBe(true);
  await panel.getByRole('button', { name: 'Create story', exact: true }).click();
  releaseOutput();
  await expect(panel.locator('.cdp-output')).toHaveCount(1);
  await expect(panel.locator('.cdp-output')).toHaveAccessibleName('Export country report');
  await expect(panel.locator('.cdp-output-paper .cdp-scorecard-input')).toHaveCount(27);
  await expect(panel.locator('.cdp-output-paper')).toContainText('128.6%');
  await expect(panel.locator('.cdp-output-paper')).toContainText('156.4');
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download report HTML', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
  const html = await readFile(testInfo.outputPath(download.suggestedFilename()), 'utf8');
  expect(html).toContain('Arms supplier diversity');
  expect(html).toContain('BIS · 2026-Q1');
  expect(html).toContain('IMF WEO 2027');
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).not.toContain('<script');
  const savedReport = await page.context().newPage();
  await savedReport.route('http://brief-export.test/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await savedReport.goto('http://brief-export.test/');
  await expect(savedReport.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'/);
  await savedReport.evaluate(() => {
    const probe = document.createElement('script');
    probe.textContent = "document.body.dataset.exportScriptRan='true'";
    document.body.append(probe);
  });
  await expect(savedReport.locator('body')).not.toHaveAttribute('data-export-script-ran', 'true');
  await expect(savedReport.locator('.cdp-scorecard-input')).toHaveCount(27);
  await expect(savedReport.locator('#export-cdp-section-housing')).toContainText('BIS · 2026-Q1');
  await savedReport.setViewportSize({ width: 390, height: 844 });
  expect(await savedReport.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await savedReport.close();
  await panel.getByRole('button', { name: '← Back to brief', exact: true }).click();
  await expect(panel).toHaveClass(/maximized/);
  await expect(factors.getByRole('tab', { name: /Defense/ })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: 'Create story', exact: true }).click();
  await expect(panel.locator('.cdp-output-paper')).toContainText('The United States has attacked three Iranian oil tankers');
  await panel.getByRole('button', { name: 'Next story slide', exact: true }).click();
  await expect(panel.locator('.cdp-output-paper')).toContainText('65% coverage');
  await page.keyboard.press('Escape');
  await expect(panel.locator('.cdp-shell')).toBeVisible();
  await expect(panel).toHaveClass(/maximized/);
  await page.setViewportSize({ width: 390, height: 844 });
  await factors.scrollIntoViewIfNeeded();
  const overflow = await panel.evaluate(element => {
    const content = element.querySelector('#deep-dive-content')!;
    return content.scrollWidth - content.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(195, 820)?.closest('#country-deep-dive-panel')))).toBe(true);
  await testInfo.attach('factors-mobile', { body: await page.screenshot({ path: testInfo.outputPath('factors-mobile.png') }), contentType: 'image/png' });
});

test('limited country coverage stays navigable and China keeps its own section', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  const data = await installCountryBriefDesignData(page);
  data.releaseFactors();
  await page.goto('/dashboard?country=LS&expanded=1');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel.locator('.cdp-country-name')).toHaveText('Lesotho');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('data-load-state', 'unavailable');
  await expect(panel.locator('#cdp-section-factors')).toContainText('Five-factor scorecard unavailable.');
  await expect(panel.locator('.cdp-scorecard-score')).toHaveCount(0);
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'All sections', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(24);
  await expect(panel.locator('#cdp-section-facts')).not.toContainText('Washington');
  await expect(panel.locator('#cdp-section-assessment')).not.toContainText('UNITED STATES');
  for (const id of ['maritime', 'trade', 'scenario']) {
    await expect(panel.locator(`#cdp-section-${id}`)).toHaveAttribute('data-load-state', 'unavailable');
  }
  await expect(panel.locator('#cdp-section-china')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(panel.locator('#cdp-section-housing')).toBeHidden();
  await expect(panel.locator('#cdp-section-assessment')).toBeVisible();
  await panel.getByRole('button', { name: 'Full brief', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(24);
  await expect(panel.locator('#cdp-section-housing')).toBeVisible();
  await page.goto('/dashboard?country=CN&expanded=1');
  await expect(panel.locator('.cdp-country-name')).toHaveText('China');
  await expect(panel.locator('#cdp-section-china')).toBeVisible();
  await expect(panel.locator('.cdp-scorecard-score')).toHaveCount(0);
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'All sections', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(25);
  await testInfo.attach('china-sections', { body: await page.screenshot({ path: testInfo.outputPath('china-sections.png') }), contentType: 'image/png' });
  expect(data.countriesRequested).toContain('LS');
  expect(data.countriesRequested).toContain('CN');
});

test('country report export keeps safe links and removes unsafe or malformed URLs', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  await page.goto('/dashboard?country=UA&expanded=1');
  await expectCountry(page);
  await marketsCard(page).evaluate(card => {
    const fixture = document.createElement('div'); fixture.className = 'export-url-fixture';
    const heading = document.createElement('h3'); heading.id = 'fixture-evidence'; heading.textContent = 'Controlled export link fixtures';
    fixture.append(heading);
    for (const [label, href] of [['Fragment', '#fixture-evidence'], ['Web source', 'https://example.com/evidence?a=1&b=2'],
      ['Relative source', '/sources'], ['Unsafe scheme', 'javascript:void(0)'], ['Data scheme', 'data:text/html,fixture'],
      ['Malformed URL', 'http://[']]) {
      const row = document.createElement('p');
      const anchor = document.createElement('a'); anchor.textContent = label!; anchor.setAttribute('href', href!);
      row.append(anchor); fixture.append(row);
    }
    card.append(fixture);
  });
  const panel = page.locator('#country-deep-dive-panel');
  await panel.getByRole('button', { name: 'Export report ↗', exact: true }).click();
  const fixture = panel.locator('.cdp-output-paper .export-url-fixture');
  await expect(fixture.locator('a[href]')).toHaveCount(3);
  await expect(fixture.getByText('Fragment', { exact: true })).toHaveAttribute('href', '#export-fixture-evidence');
  await expect(fixture.getByText('Web source', { exact: true })).toHaveAttribute('href', 'https://example.com/evidence?a=1&b=2');
  await fixture.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('export-url-policy-preview.png') });
  const event = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download report HTML', exact: true }).click();
  const download = await event;
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const html = await readFile(path, 'utf8');
  const exported = await page.context().newPage();
  await exported.route('http://brief-export.test/', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await exported.goto('http://brief-export.test/', { waitUntil: 'domcontentloaded' });
  const saved = exported.locator('.export-url-fixture');
  await expect(saved.locator('a[href]')).toHaveCount(3);
  await expect(saved.locator('a:not([href])')).toHaveText(['Unsafe scheme', 'Data scheme', 'Malformed URL']);
  await expect(saved.getByText('Relative source', { exact: true })).toHaveAttribute('href', 'https://worldmonitor.app/sources');
  await expect(exported.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'");
  await saved.scrollIntoViewIfNeeded();
  await exported.screenshot({ path: testInfo.outputPath('export-url-policy-downloaded.png') });
  await exported.close();
});
