import { test, expect } from './country-brief-fixtures';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const profileCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-profile-2026-09-10.json', 'utf8'));
const oldCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-shock-100-2026-09-10.json', 'utf8'));

const RPC = '/api/intelligence/v1/compute-energy-shock';

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
    };
    const request = {
      countryCode: url.searchParams.get('country_code'),
      chokepointId: url.searchParams.get('chokepoint_id'),
      disruptionPct: Number(url.searchParams.get('disruption_pct')),
      fuelMode: url.searchParams.get('fuel_mode'),
    };
    const body = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { computeEnergyShockScenario } from './server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
      import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
      installRedis(JSON.parse(process.argv[1]));
      console.log(JSON.stringify(await computeEnergyShockScenario({}, JSON.parse(process.argv[2]))));
    `, JSON.stringify(seed), JSON.stringify(request)], { encoding: 'utf8' });
    await route.fulfill({ body, contentType: 'application/json' });
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
  await expect(widget).toContainText('5.5%');
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
    };
    const request = {
      countryCode: url.searchParams.get('country_code'),
      chokepointId: url.searchParams.get('chokepoint_id'),
      disruptionPct: Number(url.searchParams.get('disruption_pct')),
      fuelMode: url.searchParams.get('fuel_mode'),
    };
    const body = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { computeEnergyShockScenario } from './server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
      import { installRedis } from './tests/helpers/fake-upstash-redis.mts';
      installRedis(JSON.parse(process.argv[1]));
      console.log(JSON.stringify(await computeEnergyShockScenario({}, JSON.parse(process.argv[2]))));
    `, JSON.stringify(seed), JSON.stringify(request)], { encoding: 'utf8' });
    await route.fulfill({ body, contentType: 'application/json' });
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
  await expect(widget).toContainText('Assumed monthly loss: 12395.4 terajoules');
  await expect(widget).toContainText('Share of recorded demand: 2.7%');
  await expect(widget).toContainText('Recorded liquefied natural gas share: unknown');
  await expect(widget).toContainText('observation month 2026-01');
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
  await expect(widget).toContainText('Assumed monthly loss: <0.1 terajoules');
  await expect(widget).toContainText('Share of recorded demand: <0.1%');
  lngImportsTj = 0;
  await compute.click();
  await expect(widget).toContainText('recorded zero LNG imports in 2026-01');
  totalDemandTj = null;
  await compute.click();
  await expect(widget).toContainText('Insufficient gas import data');
  await expect(widget).not.toContainText('Assumed monthly loss');
  legacy = true;
  await compute.click();
  await expect(widget).toContainText('Gas scenario uses an outdated model');
  await expect(widget).not.toContainText('9677');
  expect(requests).toHaveLength(5);
  expect(requests.every(query => query.includes('country_code=DE') && query.includes('fuel_mode=gas'))).toBe(true);
});
