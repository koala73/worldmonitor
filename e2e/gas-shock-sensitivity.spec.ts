import { test, expect } from './country-brief-fixtures';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const profileCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-profile-2026-09-10.json', 'utf8'));
const oldCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-shock-100-2026-09-10.json', 'utf8'));

const jpProfileCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/jp-profile-2026-10-28.json', 'utf8'));

const RPC = '/api/intelligence/v1/compute-energy-shock';
const LNG_KEY = 'comtrade:lng-hormuz-share:v1';

// Entries of the Hormuz LNG origin snapshot as the seeder builds them from the
// UN Comtrade HS 271111 responses recorded on 2026-10-28.
const RECORDED_LNG_ORIGIN = {
  JP: {
    preCrisis: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, share: 0.064, measure: 'weight', unattributedShare: 0 },
    current: { basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3, share: 0.0044, measure: 'weight', unattributedShare: 0 },
  },
  DE: { preCrisis: null, preCrisisUnavailable: 'partners_unattributed', current: null, currentUnavailable: 'partners_unattributed' },
};

/** Runs the real handler on `seed` for the request a route intercepted. */
function runHandler(seed: Record<string, unknown>, url: URL): string {
  const request = {
    countryCode: url.searchParams.get('country_code'),
    chokepointId: url.searchParams.get('chokepoint_id'),
    disruptionPct: Number(url.searchParams.get('disruption_pct')),
    fuelMode: url.searchParams.get('fuel_mode'),
  };
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { computeEnergyShockScenario } from './server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
    import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
    installRedis(JSON.parse(process.argv[1]));
    console.log(JSON.stringify(await computeEnergyShockScenario({}, JSON.parse(process.argv[2]))));
  `, JSON.stringify(seed), JSON.stringify(request)], { encoding: 'utf8' });
}

// Runs the real handler on the production shape of 2026-10-28 for a country with
// JODI crude imports and IEA reserves but only World-aggregate Comtrade rows, so the
// oil loss cannot be modeled. The cover row must say so rather than reading the
// handler's 0 as exhausted reserves (#9781).
test('oil cover row reads "not modeled" when the origin share is unavailable', async ({ page, countryBrief }) => {
  void countryBrief;
  await page.route('**/api/intelligence/v1/get-country-energy-profile?**', route => route.fulfill({ json: profileCapture.body }));
  await page.route(`**${RPC}?**`, async route => {
    const url = new URL(route.request().url());
    const seed = {
      'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.606 } },
      'energy:jodi-oil:v1:DE': { dataMonth: '2026-07', crude: { importsKbd: 1560 }, gasoline: { demandKbd: 454.4 }, diesel: { demandKbd: 766.7 } },
      'energy:iea-oil-stocks:v1:DE': { daysOfCover: 124, netExporter: false, anomaly: false },
      'comtrade:flows:276:2709': [{ reporterCode: '276', partnerCode: '000', partnerName: 'World', cmdCode: '2709', year: 2024, tradeValueUsd: 1 }],
      'energy:jodi-gas:v1:DE': { lngImportsTj: 25135, pipeImportsTj: 248000, totalDemandTj: 137779, lngShareOfImports: 0.092, dataMonth: '2026-07' },
      // A measured gas share keeps the combined scenario available, which is what
      // puts the cover row on screen. Germany's recorded entry is unavailable (last test).
      [LNG_KEY]: { countries: { DE: { preCrisis: { basis: 'comtrade_annual', fromMonth: '2025-01', toMonth: '2025-12', monthsCovered: 12, share: 0.25, measure: 'weight', unattributedShare: 0 }, current: null, currentUnavailable: 'no_rows' } } },
    };
    await route.fulfill({ body: runHandler(seed, url), contentType: 'application/json' });
  });
  await page.goto('/dashboard?country=DE');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const card = panel.locator('#cdp-section-energy');
  const widget = card.getByText('Shock Scenario', { exact: true }).locator('..');
  await expect(card.getByText('Shock Scenario', { exact: true })).toBeVisible();
  const selects = widget.locator('select');
  await selects.nth(1).selectOption('100');
  await selects.nth(2).selectOption('both');
  await widget.getByRole('button', { name: 'Compute', exact: true }).click();
  await expect(widget).toContainText('IEA cover: not modeled for this scenario (crude import inputs unavailable)');
  await expect(widget).not.toContainText('reserves exhausted');
  await expect(widget).toContainText('Crude import origin share unavailable for DE');
  // 25% of 25,135 TJ against 137,779 TJ of demand.
  await expect(widget).toContainText('Share of recorded demand: 4.6%');
});

test('gas scenario renders handler sensitivity, dates, unknowns and rejects old cached claims', async ({ page, countryBrief }, testInfo) => {
  void countryBrief;
  const profile = profileCapture.body;
  let legacy = false;
  let lngImportsTj = profile.gasLngImportsTj;
  let totalDemandTj: number | null = profile.gasTotalDemandTj;
  const requests: string[] = [];
  await page.route('**/api/intelligence/v1/get-country-energy-profile?**', route => route.fulfill({ json: profile }));
  await page.route(`**${RPC}?**`, async route => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    if (legacy) return route.fulfill({ json: oldCapture.body });
    const seed = {
      'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.122 } },
      'energy:jodi-gas:v1:DE': { lngImportsTj, totalDemandTj, dataMonth: profile.jodiGasDataMonth },
      'energy:gas-storage:v1:DE': oldCapture.body.gasImpact.storage,
      // A measured 30% share drives these rendering checks; Germany's recorded
      // snapshot entry is unavailable (see the first and last tests).
      [LNG_KEY]: { countries: { DE: { preCrisis: { basis: 'comtrade_annual', fromMonth: '2025-01', toMonth: '2025-12', monthsCovered: 12, share: 0.3, measure: 'weight', unattributedShare: 0 }, current: null, currentUnavailable: 'no_rows' } } },
    };
    await route.fulfill({ body: runHandler(seed, url), contentType: 'application/json' });
  });
  await page.goto('/dashboard?country=DE');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
  const card = panel.locator('#cdp-section-energy');
  const widget = card.getByText('Shock Scenario', { exact: true }).locator('..');
  await expect(card.getByText('Shock Scenario', { exact: true })).toBeVisible();
  const selects = widget.locator('select');
  await selects.nth(1).selectOption('100');
  await selects.nth(2).selectOption('gas');
  const compute = widget.getByRole('button', { name: 'Compute', exact: true });
  await compute.click();
  // Plain-language unit and acronym labels since #9036.
  await expect(widget).toContainText('Monthly loss at the pre-crisis share: 12395.4 terajoules');
  await expect(widget).toContainText('Share of recorded demand: 2.7%');
  await expect(widget).toContainText('Recorded liquefied natural gas share: unknown');
  await expect(widget).toContainText('pre-crisis 30.0% (2025 annual) | current flows unavailable');
  await expect(widget).toContainText('observation month 2026-01; LNG origin: UN Comtrade');
  await expect(widget).not.toContainText('Assumed monthly loss');
  await expect(widget).toContainText('observed 2026-09-07');
  await expect(widget).toContainText('Operational endurance is not estimated');
  await expect(widget).not.toContainText('9677');
  await expect(widget).toContainText('partial');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('gas-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(compute).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('gas-mobile.png') });
  lngImportsTj = 0.001;
  await compute.click();
  await expect(widget).toContainText('Monthly loss at the pre-crisis share: <0.1 terajoules');
  await expect(widget).toContainText('Share of recorded demand: <0.1%');
  lngImportsTj = 0;
  await compute.click();
  await expect(widget).toContainText('recorded zero LNG imports in 2026-01');
  totalDemandTj = null;
  await compute.click();
  await expect(widget).toContainText('Insufficient gas import data');
  await expect(widget).not.toContainText('Monthly loss');
  legacy = true;
  await compute.click();
  await expect(widget).toContainText('Gas scenario uses an outdated model');
  await expect(widget).not.toContainText('9677');
  expect(requests).toHaveLength(5);
  expect(requests.every(query => query.includes('country_code=DE') && query.includes('fuel_mode=gas'))).toBe(true);
});

// Production inputs of 2026-10-28 (JODI gas, PortWatch RED) with the recorded
// UN Comtrade LNG shares: Japan shows both labelled baselines, Germany the
// unavailable origin share.
test('Hormuz LNG renders both measured baselines for Japan and an unavailable share for Germany', async ({ page, countryBrief }, testInfo) => {
  void countryBrief;
  const profiles: Record<string, unknown> = { JP: jpProfileCapture.body, DE: profileCapture.body };
  await page.route('**/api/intelligence/v1/get-country-energy-profile?**', route => {
    const code = new URL(route.request().url()).searchParams.get('country_code') ?? '';
    return route.fulfill({ json: profiles[code] ?? profileCapture.body });
  });
  await page.route(`**${RPC}?**`, async route => {
    const url = new URL(route.request().url());
    const seed = {
      'energy:chokepoint-flows:v1': { hormuz_strait: { currentMbd: 12.7, baselineMbd: 21, flowRatio: 0.606 } },
      'energy:jodi-gas:v1:JP': { dataMonth: '2026-07', lngImportsTj: 274197, totalDemandTj: 299947, lngShareOfImports: 1 },
      'energy:jodi-gas:v1:DE': { dataMonth: '2026-07', lngImportsTj: 25135, totalDemandTj: 137779, lngShareOfImports: 0.0919 },
      [LNG_KEY]: { countries: RECORDED_LNG_ORIGIN },
    };
    await route.fulfill({ body: runHandler(seed, url), contentType: 'application/json' });
  });
  const open = async (code: string) => {
    await page.goto(`/dashboard?country=${code}`);
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Resources & infrastructure', exact: true }).click();
    const card = panel.locator('#cdp-section-energy');
    const widget = card.getByText('Shock Scenario', { exact: true }).locator('..');
    await expect(card.getByText('Shock Scenario', { exact: true })).toBeVisible();
    const selects = widget.locator('select');
    await selects.nth(1).selectOption('100');
    await selects.nth(2).selectOption('gas');
    await widget.getByRole('button', { name: 'Compute', exact: true }).click();
    return { card, widget };
  };

  const jp = await open('JP');
  await expect(jp.widget).toContainText('Gas / liquefied natural gas Hormuz exposure');
  await expect(jp.widget).toContainText('Monthly loss at the pre-crisis share: 17548.6 terajoules');
  await expect(jp.widget).toContainText('Share of recorded demand: 5.9%');
  await expect(jp.widget).toContainText('pre-crisis 6.4% (2025-02 to 2026-01) | current flows 0.4% (2026-06 to 2026-08), monthly loss 1206.5 terajoules');
  await expect(jp.widget).not.toContainText('Assumed monthly loss');
  await expect(jp.widget).not.toContainText('assumes 30%');
  await jp.card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('lng-jp-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await jp.card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('lng-jp-mobile.png') });

  await page.setViewportSize({ width: 1280, height: 800 });
  const de = await open('DE');
  await expect(de.widget).toContainText('LNG origin share unavailable for DE; Strait of Hormuz LNG exposure is not modeled.');
  await expect(de.widget).not.toContainText('terajoules');
  await de.card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('lng-de-desktop.png') });
});
