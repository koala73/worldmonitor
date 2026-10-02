import { test, expect } from './country-brief-fixtures';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const profileCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-profile-2026-09-10.json', 'utf8'));
const oldCapture = JSON.parse(readFileSync('tests/fixtures/energy-shock/de-shock-100-2026-09-10.json', 'utf8'));

const RPC = '/api/intelligence/v1/compute-energy-shock';

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
  await expect(widget).toContainText('Assumed monthly loss: 12395.4 TJ');
  await expect(widget).toContainText('Share of recorded demand: 2.7%');
  await expect(widget).toContainText('Recorded LNG share: unknown');
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
  await expect(widget).toContainText('Assumed monthly loss: <0.1 TJ');
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
