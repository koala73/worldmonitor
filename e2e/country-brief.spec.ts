import type { Page, TestInfo } from '@playwright/test';
import { test, expect, HYDRATED_MARKET } from './country-brief-fixtures';
import { readFile } from 'node:fs/promises';
import { installCountryBriefDesignData, installDecisionBriefData, installCommodityBriefData } from './country-brief-design-fixtures';

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

test('US brief keeps late evidence, metric design and report data connected', async ({ page, countryBrief }, testInfo) => {
  countryBrief.response = { markets: [], dataAvailable: true, fetchedAt: 0 };
  const data = await installCountryBriefDesignData(page);
  await page.goto('/dashboard?country=US&expanded=1');
  const panel = page.locator('#country-deep-dive-panel');
  const topic = (name: string) => panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name, exact: true });
  await expect(panel.locator('.cdp-country-name')).toHaveText('United States');
  await expect(panel.locator('#cdp-section-factors')).toHaveAttribute('aria-busy', 'true');
  await topic('Economy & trade').click();
  const housing = panel.locator('#cdp-section-housing');
  await expect(housing.locator('.cdp-metric-hero')).toHaveText(['156.4', '186.6', '8.0']);
  await expect(housing).toContainText('-2.1% · ↓ Falling');
  await expect(housing).toContainText('BIS · 2026-Q1');
  await expect(panel.locator('#cdp-section-debt .cdp-metric-hero')).toHaveText('128.6%');
  await expect(panel.locator('#cdp-section-debt')).toContainText('source value needs review');
  await expect(panel.locator('#cdp-section-tariffs')).toContainText('→ Unchanged');
  data.releaseFactors();
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
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(23);
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
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(23);
  await expect(panel.locator('#cdp-section-housing')).toBeVisible();
  await page.goto('/dashboard?country=CN&expanded=1');
  await expect(panel.locator('.cdp-country-name')).toHaveText('China');
  await expect(panel.locator('#cdp-section-china')).toBeVisible();
  await expect(panel.locator('.cdp-scorecard-score')).toHaveCount(0);
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'All sections', exact: true }).click();
  await expect(panel.locator('[data-brief-section]:visible')).toHaveCount(24);
  await testInfo.attach('china-sections', { body: await page.screenshot({ path: testInfo.outputPath('china-sections.png') }), contentType: 'image/png' });
  expect(data.countriesRequested).toContain('LS');
  expect(data.countriesRequested).toContain('CN');
});

for (const mobile of [false, true]) {
  test(`operational worksheet ${mobile ? 'mobile' : 'desktop'} edits day 8/day 10 and imports actual downloads`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const state = await installDecisionBriefData(page);
    await page.goto(`/dashboard?country=DE${mobile ? '' : '&expanded=1'}`);
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    const output = panel.getByRole('region', { name: 'Decision brief', exact: true });
    const form = output.getByRole('region', { name: 'Operational what-if worksheet', exact: true });
    const briefFont = await panel.locator('.cdp-shell').evaluate(element => getComputedStyle(element).fontFamily);
    await expect(form).toHaveCSS('font-family', briefFont);
    await expect(form.locator('.operational-summary')).toContainText('Baseline first gap: Day 8. Alternative first gap: Day 8.');
    await expect(form).toContainText('Labeled example');
    expect(state.requests).toHaveLength(0);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('worksheet-example.png'), fullPage: true });
    await form.getByRole('button', { name: 'Add alternative delivery', exact: true }).click();
    await expect(form.locator('.operational-result')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Export worksheet JSON' })).toBeDisabled();
    await form.getByLabel('Alternative delivery date', { exact: true }).fill('2026-09-17');
    await form.getByLabel('Alternative delivery quantity', { exact: true }).fill('40');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await expect(form.locator('[data-day="8"] td')).toHaveText(['0', '20', '0', '20', '40', '20', '20', '0']);
    await expect(form.locator('[data-day="10"] td')).toHaveText(['0', '20', '0', '20', '0', '20', '0', '20']);
    await expect(form).toContainText('Delivery cost comparison unavailable');
    await form.locator(mobile ? '.operational-result' : '.operational-header').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('worksheet-day10.png'), fullPage: true });
    const event = page.waitForEvent('download');
    await form.getByRole('button', { name: 'Export worksheet JSON' }).click();
    const download = await event;
    const worksheetPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(worksheetPath);
    const worksheet = JSON.parse(await readFile(worksheetPath, 'utf8'));
    expect(worksheet.baseline.days.map((day: { unmetDemand: number }) => day.unmetDemand)).toEqual([0,0,0,0,0,0,0,20,20,20]);
    expect(worksheet.alternative.days.map((day: { unmetDemand: number }) => day.unmetDemand)).toEqual([0,0,0,0,0,0,0,0,0,20]);
    await form.getByLabel('Alternative delivery date', { exact: true }).fill('2026-09-18');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 8');
    await form.getByLabel('Import worksheet JSON', { exact: true }).setInputFiles(worksheetPath);
    await expect(form).toContainText('Worksheet imported');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await form.getByLabel('Import worksheet JSON', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
    await expect(form).toContainText('Import rejected');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await form.getByLabel('Import worksheet JSON', { exact: true }).setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.from(' '.repeat(65537)) });
    await expect(form).toContainText('64 KiB');
    await output.getByRole('button', { name: 'Capture / refresh both' }).click();
    await expect(output.getByRole('status')).toContainText('Captured.');
    const paper = output.locator('.cdp-decision-paper');
    await expect(paper.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    const preview = JSON.parse(await paper.locator('#decision-brief-snapshot').textContent() ?? 'null');
    expect(preview.operationalWorksheet).toEqual(worksheet);
    for (const format of ['HTML', 'JSON']) {
      const event = page.waitForEvent('download');
      await output.getByRole('button', { name: `Download decision ${format}`, exact: true }).click();
      const download = await event;
      const path = testInfo.outputPath(download.suggestedFilename());
      await download.saveAs(path);
      const contents = await readFile(path, 'utf8');
      if (format === 'JSON') expect(JSON.parse(contents)).toEqual(preview);
      else {
        const exported = await page.context().newPage();
        await exported.route('http://worksheet-export.test/', route => route.fulfill({ body: contents, contentType: 'text/html' }));
        await exported.goto('http://worksheet-export.test/');
        expect(JSON.parse(await exported.locator('#decision-brief-snapshot').textContent() ?? 'null')).toEqual(preview);
        await expect(exported.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
        await expect(exported.locator('a[href]').first()).toHaveAttribute('href', /https:/);
        await exported.screenshot({ path: testInfo.outputPath('worksheet-export.png'), fullPage: true });
        await exported.close();
      }
    }
    await form.locator('.operational-summary').scrollIntoViewIfNeeded();
    expect(await output.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test(`operational worksheet ${mobile ? 'mobile' : 'desktop'} rejects invalid inputs and retains reopened drafts`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await installDecisionBriefData(page);
    await page.goto(`/dashboard?country=DE${mobile ? '' : '&expanded=1'}`);
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    const output = panel.getByRole('region', { name: 'Decision brief', exact: true });
    const form = output.getByRole('region', { name: 'Operational what-if worksheet', exact: true });
    const worksheetFile = {
      name: 'recovery-worksheet.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        schema: 'worldmonitor-operational-worksheet/v1',
        input: {
          operation: 'Recovery example', basis: 'user', unit: 'units',
          startDate: '2026-09-10', horizonDays: 10, startingStock: 100, dailyDemand: 20,
          deliveries: [{ date: '2026-09-13', quantity: 40, unit: 'units', costUsd: null }],
          alternativeDeliveries: [{ date: '2026-09-17', quantity: 40, unit: 'units', costUsd: null }],
          alternativeDailyDemand: null,
        },
      })),
    };
    await form.getByLabel('Import worksheet JSON', { exact: true }).setInputFiles(worksheetFile);
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await output.getByRole('button', { name: 'Capture / refresh both' }).click();
    await expect(output.getByRole('status')).toContainText('Captured.');
    const paper = output.locator('.cdp-decision-paper');
    await form.getByLabel('Starting usable stock', { exact: true }).fill('');
    await expect(form.locator('.operational-result')).toHaveCount(0);
    await expect(paper).toContainText('Operational worksheet incomplete or invalid');
    await expect(paper.locator('.operational-result')).toHaveCount(0);
    const invalidEvent = page.waitForEvent('download');
    await output.getByRole('button', { name: 'Download decision JSON' }).click();
    const invalidDownload = await invalidEvent;
    const invalidPath = testInfo.outputPath('incomplete-decision.json');
    await invalidDownload.saveAs(invalidPath);
    expect(JSON.parse(await readFile(invalidPath, 'utf8')).operationalWorksheet).toBeNull();
    await form.getByLabel('Import worksheet JSON', { exact: true }).setInputFiles(worksheetFile);
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await form.getByLabel('Alternative daily demand (blank keeps baseline)', { exact: true }).fill('10');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: None within horizon');
    const alternativeDemand = form.getByLabel('Alternative daily demand (blank keeps baseline)', { exact: true });
    await alternativeDemand.fill('');
    await alternativeDemand.press('e');
    expect(await alternativeDemand.evaluate((field: HTMLInputElement) => field.validity.badInput)).toBe(true);
    await expect(form.locator('.operational-result')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Export worksheet JSON' })).toBeDisabled();
    await expect(paper.locator('.operational-result')).toHaveCount(0);
    expect(JSON.parse(await paper.locator('#decision-brief-snapshot').textContent() ?? 'null').operationalWorksheet).toBeNull();
    await output.getByRole('button', { name: '← Back to brief', exact: true }).click();
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    await expect(form.locator('.operational-result')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Export worksheet JSON' })).toBeDisabled();
    await alternativeDemand.fill('10');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: None within horizon');
    await alternativeDemand.fill('');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: Day 10');
    await expect(form.getByRole('button', { name: 'Export worksheet JSON' })).toBeEnabled();
    await alternativeDemand.fill('10');
    await output.getByRole('button', { name: '← Back to brief', exact: true }).click();
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    await expect(form.getByLabel('Alternative daily demand (blank keeps baseline)', { exact: true })).toHaveValue('10');
    await expect(form.locator('.operational-summary')).toContainText('Alternative first gap: None within horizon');
    await form.getByLabel('Daily demand', { exact: true }).fill('');
    await output.getByRole('button', { name: '← Back to brief', exact: true }).click();
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    await expect(form.getByLabel('Daily demand', { exact: true })).toHaveValue('');
    await expect(form.locator('.operational-result')).toHaveCount(0);
    await expect(form).toContainText('Daily demand is required');
  });
}


for (const mobile of [false, true]) {
  test(`decision brief ${mobile ? 'mobile' : 'desktop'} preserves evidence and actions in actual downloads`, async ({ page, countryBrief }, testInfo) => {
    void countryBrief;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const state = await installDecisionBriefData(page);
    await page.goto('/dashboard?country=DE');
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
    const output = panel.getByRole('region', { name: 'Decision brief', exact: true });
    await expect(output).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('decision-before.png') });
    for (const mode of ['ready', 'missing', 'mismatch'] as const) {
      state.mode = mode;
      await output.getByRole('button', { name: 'Capture / refresh both' }).click();
      await expect(output.getByRole('status')).toContainText('Captured.');
      const paper = output.locator('.cdp-decision-paper');
      await expect(paper).toContainText(mode === 'missing' ? 'Recover recorded LNG imports' : "Compare Germany's supply obligations and alternative origins");
      if (mode !== 'missing') {
        await expect(paper).toContainText('6,197.7 TJ');
        await expect(paper).toContainText('12,395.4 TJ');
        await expect(paper).toContainText('1.3 %');
        await expect(paper).toContainText('2.7 %');
        await expect(paper).toContainText('2025-01-02');
      }
      if (mode === 'mismatch') await expect(paper.locator('.cdp-decision-comparison')).toContainText('Numeric delta withheld');
      const preview = JSON.parse(await paper.locator('#decision-brief-snapshot').textContent() ?? 'null');
      const files: Record<string, string> = {};
      for (const format of ['HTML', 'JSON']) {
        const event = page.waitForEvent('download');
        await output.getByRole('button', { name: `Download decision ${format}`, exact: true }).click();
        const download = await event;
        const path = testInfo.outputPath(`${mode}-${download.suggestedFilename()}`);
        await download.saveAs(path);
        files[format] = await readFile(path, 'utf8');
        await testInfo.attach(`${mode}-${format}`, { path, contentType: format === 'HTML' ? 'text/html' : 'application/json' });
      }
      expect(JSON.parse(files.JSON!)).toEqual(preview);
      const exported = await page.context().newPage();
      await exported.route('http://decision-export.test/', route => route.fulfill({ body: files.HTML!, contentType: 'text/html' }));
      await exported.goto('http://decision-export.test/');
      expect(JSON.parse(await exported.locator('#decision-brief-snapshot').textContent() ?? 'null')).toEqual(preview);
      await expect(exported.locator('.cdp-decision-action')).toHaveText(preview.action.text);
      await expect(exported.locator('body')).toContainText(preview.action.constraint);
      await expect(exported.locator('body')).toContainText(preview.action.trigger);
      for (const ref of preview.action.references) await expect(exported.locator('body')).toContainText(ref);
      await exported.screenshot({ path: testInfo.outputPath(`${mode}-export.png`), fullPage: true });
      await exported.close();
      await paper.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${mode}-preview.png`) });
      expect(await output.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(state.requests).toHaveLength(6);
  });
}

test('decision brief request failures recover and a second country uses its own evidence', async ({ page, countryBrief }) => {
  void countryBrief;
  const state = await installDecisionBriefData(page);
  await page.goto('/dashboard?country=JP');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
  const output = panel.locator('.cdp-output');
  for (const mode of ['denied', 'error'] as const) {
    state.mode = mode;
    await output.getByRole('button', { name: 'Capture / refresh both' }).click();
    await expect(output.getByRole('status')).toContainText('Check your access and retry');
    await expect(output.getByRole('button', { name: 'Download decision JSON' })).toBeDisabled();
  }
  state.mode = 'ready';
  await output.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect(output.locator('.cdp-decision-paper')).toContainText("Compare Japan's supply obligations");
  await expect(output.locator('.cdp-decision-paper')).toContainText('15,000.0 TJ');
  await expect(output.locator('.cdp-decision-paper')).not.toContainText('Germany');
  await output.getByLabel('Comparison disruption').selectOption('75');
  await expect(output.getByRole('button', { name: 'Download decision JSON' })).toBeDisabled();
  await expect(output.getByRole('status')).toContainText('Selection changed');
  await output.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect(output.locator('.cdp-decision-paper')).toContainText('22,500.0 TJ');
  await output.getByLabel('Fuel', { exact: true }).selectOption('oil');
  await output.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect(output.locator('.cdp-decision-paper')).toContainText('100.0 kbd');
  await expect(output.locator('.cdp-decision-comparison')).toContainText('Numeric delta withheld');
  await expect(output.locator('.cdp-decision-paper')).toContainText('observed unknown');
});

test('decision brief rejects anonymous entry and ignores delayed responses after close and country change', async ({ page, countryBrief }) => {
  void countryBrief;
  await page.goto('/dashboard?country=DE');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
  await expect(page.getByText('Decision brief is available on Pro.', { exact: true })).toBeVisible();
  await expect(panel.locator('.cdp-output')).toHaveCount(0);
  await installDecisionBriefData(page);
  await page.reload();
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let pending = 0;
  await page.route('**/api/intelligence/v1/compute-energy-shock*', async route => {
    pending++;
    await held;
    await route.fallback();
  });
  await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
  await panel.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect.poll(() => pending).toBe(2);
  await panel.locator('#deep-dive-close').click();
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await page.locator('#searchBtn').click();
  await page.locator('.search-modal .search-input').fill('Japan');
  await page.locator('.search-result-item[data-index]').filter({ hasText: 'Brief: Japan' }).click();
  await expect(panel.locator('.cdp-country-name')).toHaveText('Japan');
  await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
  // Positive control: a real, live, freshly-built output is mounted and waiting for a
  // capture before the stale Germany responses land. Without this the checks below
  // would also hold against an empty panel, which is what made them vacuous.
  await expect(panel.locator('.cdp-output')).toHaveCount(1);
  await expect(panel.locator('.cdp-output')).toContainText('Select an energy disruption');
  release();
  await expect(panel.locator('.cdp-output')).not.toContainText('Germany');
  await expect(panel.locator('.cdp-decision-paper')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Download decision JSON' })).toBeDisabled();
});

// Browser-level coverage for invalidation while a capture is in flight: the selection
// change aborts the request, so the paper must clear, both exports must stay disabled,
// and Capture must come back enabled (it is disabled for the duration of a capture, and
// the in-flight handler declines to re-enable a button it no longer owns).
//
// This does NOT pin the stale-response generation guard, and no browser test can: the
// abort rejects the fetch, so the success path is never reached. That guard is pinned by
// the mocked-load case in tests/dom/decision-brief.test.mts ("ignores late responses
// after selection changes, close and panel abort"), which resolves despite the abort —
// verified red by deleting `if (signal.aborted || current !== generation) return;`.
test('decision brief clears and stays usable when a selection change aborts a capture', async ({ page, countryBrief }) => {
  void countryBrief;
  await installDecisionBriefData(page);
  await page.goto('/dashboard?country=DE');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let pending = 0;
  await page.route('**/api/intelligence/v1/compute-energy-shock*', async route => {
    pending++;
    await held;
    await route.fallback();
  });
  await panel.getByRole('button', { name: 'Decision brief', exact: true }).click();
  await panel.getByRole('button', { name: 'Capture / refresh both' }).click();
  await expect.poll(() => pending).toBe(2);
  // Invalidate while the capture is still in flight; the output stays in the document,
  // unlike the close/country-change path above which detaches it outright.
  await panel.getByLabel('Comparison disruption').selectOption('75');
  await expect(panel.locator('.cdp-output')).toContainText('Selection changed');
  release();
  await expect(panel.locator('.cdp-decision-paper')).toHaveCount(0);
  await expect(panel.locator('.cdp-output')).toContainText('Selection changed');
  await expect(panel.getByRole('button', { name: 'Download decision HTML' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Download decision JSON' })).toBeDisabled();
  // The aborted capture must leave the control usable, not permanently disabled.
  await expect(panel.getByRole('button', { name: 'Capture / refresh both' })).toBeEnabled();
});

for (const { mobile, light } of [{ mobile: false, light: false }, { mobile: true, light: false }, { mobile: false, light: true }, { mobile: true, light: true }]) test(`commodity decision brief ${mobile ? 'mobile' : 'desktop'} ${light ? 'light' : 'dark'} captures selection and actual exports`, async ({ page, countryBrief }, testInfo) => {
  void countryBrief;
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await installCommodityBriefData(page);
  await page.addInitScript(theme => localStorage.setItem('worldmonitor-theme', theme), light ? 'light' : 'dark');
  await page.goto(`/dashboard?country=JP${light && !mobile ? '&expanded=1' : ''}`);
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await panel.getByRole('button', { name: 'Commodity decision brief', exact: true }).click();
  const output = panel.getByRole('region', { name: 'Commodity decision brief', exact: true });
  await expect(output.getByLabel('Commodity / product', { exact: true })).toHaveValue('helium');
  await page.screenshot({ path: testInfo.outputPath('before.png') });
  for (const commodity of ['helium', 'wheat', 'lithium']) {
    await output.getByLabel('Commodity / product', { exact: true }).selectOption(commodity);
    await expect(output.getByRole('button', { name: 'Download decision JSON' })).toBeDisabled();
    await output.getByRole('button', { name: 'Capture commodity comparison' }).click();
    await expect(output.getByRole('status')).toContainText('Captured.');
    const paper = output.locator('.cdp-commodity-paper');
    expect(await paper.evaluate(el => getComputedStyle(el).color)).toBe(
      await output.evaluate(el => getComputedStyle(el).color),
    );
    expect(await paper.evaluate(el => getComputedStyle(el).getPropertyValue('--panel-bg').trim())).toBe(
      await output.evaluate(el => getComputedStyle(el).getPropertyValue('--panel-bg').trim()),
    );
    const snapshot = JSON.parse(await paper.locator('#commodity-brief-snapshot').textContent() ?? 'null');
    if (commodity === 'helium') {
      await expect(paper).toContainText('hospital helium supplier share');
      await expect(paper.locator('[data-origin="QA"]')).toContainText('Strait of Hormuz');
      expect(snapshot.candidates.find((c: { origin: string }) => c.origin === 'QA').routeState).toBe('exposed');
      expect(snapshot.candidates.find((c: { origin: string }) => c.origin === 'ZZ').routeState).toBe('unknown');
      const details = paper.locator('[data-origin="QA"] details');
      await details.locator('summary').focus();
      await details.locator('summary').press('Enter');
      await expect(details).toHaveAttribute('open', '');
      expect(await details.locator('summary').evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
      await expect(details).toContainText('UN Comtrade bilateral HS4');
      await details.locator('summary').click();
    } else if (commodity === 'wheat') {
      expect(snapshot.candidates.map((c: { origin: string }) => c.origin)).toEqual(['AU']);
      await expect(paper).toContainText('2023');
      await expect(paper).not.toContainText('hospital');
    } else await expect(paper).toContainText('No recorded HS 2836 bilateral product evidence');
    const files: Record<string, string> = {};
    for (const format of ['HTML', 'JSON']) {
      const event = page.waitForEvent('download');
      await output.getByRole('button', { name: `Download decision ${format}`, exact: true }).click();
      const download = await event;
      const path = testInfo.outputPath(`${commodity}-${download.suggestedFilename()}`);
      await download.saveAs(path); files[format] = await readFile(path, 'utf8');
    }
    expect(JSON.parse(files.JSON!)).toEqual(snapshot);
    const exported = await page.context().newPage();
    await exported.route('http://commodity-export.test/', route => route.fulfill({ body: files.HTML!, contentType: 'text/html' }));
    await exported.goto('http://commodity-export.test/');
    expect(JSON.parse(await exported.locator('#commodity-brief-snapshot').textContent() ?? 'null')).toEqual(snapshot);
    await expect(exported.locator('.cdp-decision-action')).toHaveText(snapshot.action.text);
    await expect(exported.locator('body')).toContainText(snapshot.action.constraint);
    await expect(exported.locator('body')).toContainText(snapshot.action.trigger);
    await exported.screenshot({ path: testInfo.outputPath(`${commodity}-export.png`), fullPage: true });
    await exported.close();
    await panel.locator('.panel-content').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`${commodity}-preview.png`) });
    expect(await output.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
});
