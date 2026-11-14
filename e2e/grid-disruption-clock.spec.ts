import { expect, test, type Page } from '@playwright/test';
import { acceptTesterKeySession } from './helpers/accept-tester-key-session';
import type { GridClockSnapshot } from '../shared/grid-disruption-clock.js';

function fixture(now: number): GridClockSnapshot {
  const source = { sourceName: 'Fixture utility', sourceUrl: 'https://example.org/power',
    coverageKey: 'fixture-ca', coverageLabel: 'Participating California utilities', customersTracked: null };
  const grid = { kind: 'grid', sourceName: 'Fixture grid operator', sourceUrl: 'https://example.org/grid' } as const;
  const weather = { kind: 'weather', sourceName: 'Fixture weather service', sourceUrl: 'https://example.org/weather' } as const;
  return { regions: [
    { code: 'CA', current: { ...source, observedAt: now - 120_000, customersOut: 12_480 },
      history: [{ ...source, observedAt: now - 720_000, customersOut: 18_200 }],
      warnings: [{ ...grid, title: 'Regional energy emergency watch', issuedAt: now - 30_000, expiresAt: now + 90_000 }],
      warningsCheckedAt: now, warningSources: [{ ...grid, checkedAt: now, status: 'available' }] },
    { code: 'TN', current: null, history: [],
      warnings: [{ ...weather, title: 'High wind warning', issuedAt: now - 3_600_000, expiresAt: now + 7_200_000 }],
      warningsCheckedAt: now, warningSources: [
        { ...weather, checkedAt: now, status: 'available' },
        { ...grid, sourceName: 'Tennessee Valley Authority', checkedAt: null, status: 'not_monitored' },
      ] },
    ...(['TX', 'FL', 'NY', 'WA'] as const).map((code, index) => ({
      code, current: code === 'WA' ? null : { ...source, coverageKey: code,
        coverageLabel: 'Participating utilities in ' + code, observedAt: now - 120_000, customersOut: [321, 0, 654][index]! },
      history: [], warnings: [], warningsCheckedAt: now,
      warningSources: [{ ...weather, checkedAt: now, status: 'available' as const }],
    })),
  ] };
}

async function seedDashboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-pro-key', 'e2e-grid-clock');
    localStorage.setItem('panel-order', JSON.stringify(['grid-disruption-clock', 'map']));
  });
  await acceptTesterKeySession(page);
}

test('enable grid clock, inspect a California warning and Tennessee coverage', async ({ page }, testInfo) => {
  await seedDashboard(page);
  const snapshot = fixture(Date.now());
  await page.clock.install({ time: new Date() });
  let requests = 0;
  await page.route('**/api/bootstrap?keys=gridDisruptionClock&public=1', route => {
    requests++;
    return route.fulfill({ json: { data: { gridDisruptionClock: snapshot } } });
  });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible({ timeout: 60_000 });
  const panel = page.locator('#panelsGrid .panel[data-panel="grid-disruption-clock"]');
  await expect(panel).toHaveCount(0);
  expect(requests).toBe(0);
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('[data-settings-nav="panels"]').click();
  await page.locator('#usPanelToggles [data-panel="grid-disruption-clock"]').click();
  await page.locator('.panels-save-layout').click();
  await page.locator('.unified-settings-close').click();
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByText('12,480', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/5,720 fewer reported out/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Reported changes', exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Recovery', exact: true })).toHaveCount(0);
  await expect(panel.getByText('Regional energy emergency watch')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Fixture utility' })).toHaveAttribute('href', 'https://example.org/power');
  await expect(panel.getByText(/Tracked customer total unknown/)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-panels')!)['grid-disruption-clock'].enabled)).toBe(true);
  const californiaScreenshot = testInfo.outputPath('california-desktop.png');
  await panel.screenshot({ path: californiaScreenshot });
  await testInfo.attach('California fixture, declining count', { path: californiaScreenshot, contentType: 'image/png' });
  const requestsBeforeTick = requests;
  await page.clock.fastForward(120_000);
  await expect(panel.getByText('Regional energy emergency watch')).toHaveCount(0);
  await expect(panel.getByText('12,480', { exact: true })).toBeVisible();
  expect(requests).toBe(requestsBeforeTick);
  const expiredScreenshot = testInfo.outputPath('california-expired.png');
  await panel.screenshot({ path: expiredScreenshot });
  await testInfo.attach('California warning expires without fetching', { path: expiredScreenshot, contentType: 'image/png' });
  await panel.getByRole('button', { name: 'New York', exact: true }).click();
  await expect(panel.getByText('654', { exact: true })).toBeVisible();
  await expect(panel.getByText('Grid notice · Check operator directly', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Tennessee Valley Authority' })).toHaveCount(0);
  const newYorkScreenshot = testInfo.outputPath('new-york-desktop.png');
  await panel.screenshot({ path: newYorkScreenshot });
  await testInfo.attach('New York fixture, six-state selector', { path: newYorkScreenshot, contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Texas', exact: true }).click();
  await expect(panel.getByText('321', { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(panel.getByRole('button', { name: 'Texas', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Florida', exact: true }).click();
  await expect(panel.locator('.grid-clock-total')).toHaveText('0');
  await panel.getByRole('button', { name: 'Washington', exact: true }).click();
  await expect(panel.locator('.grid-clock-total')).toHaveText('Unknown');
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const washingtonScreenshot = testInfo.outputPath('washington-mobile.png');
  await panel.screenshot({ path: washingtonScreenshot });
  await testInfo.attach('Washington fixture, missing count on mobile', { path: washingtonScreenshot, contentType: 'image/png' });
  await panel.getByRole('button', { name: 'Tennessee' }).click();
  await expect(panel.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(panel.getByText('High wind warning')).toBeVisible();
  await panel.getByText('Warning source coverage').click();
  await expect(panel.getByText(/Check operator directly/)).toBeVisible();
  await panel.getByText('Warning source coverage').click();
  await expect(panel.getByText(/5,720/)).toHaveCount(0);
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const tennesseeScreenshot = testInfo.outputPath('tennessee-mobile.png');
  await panel.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const mobileBox = (await panel.boundingBox())!;
  const navBox = (await page.locator('#mobileTabBar').boundingBox())!;
  await page.screenshot({ path: tennesseeScreenshot, clip: {
    x: mobileBox.x, y: mobileBox.y, width: mobileBox.width,
    height: Math.min(mobileBox.height, navBox.y - mobileBox.y),
  } });
  await testInfo.attach('Tennessee fixture, warning with missing count, mobile', { path: tennesseeScreenshot, contentType: 'image/png' });
});
