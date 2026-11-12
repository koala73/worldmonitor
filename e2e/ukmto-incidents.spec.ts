import { test, expect } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

test('UKMTO Settings search uses the translated panel label', async ({ page }, testInfo) => {
  await seedAnonymousDashboard(page, 'full', {
    initializeOnce: {
      sessionKey: '__ukmto_locale_test__', clearStorage: true,
      localStorage: { 'wm-locale-explicit': 'fr' },
    },
  });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('#us-tab-panels').click();
  await page.locator('.panels-search input').fill('Incidents UKMTO');
  const toggle = page.locator('#usPanelToggles [data-panel="ukmto-incidents"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('Incidents UKMTO');
  await page.locator('#us-tab-panel-panels').screenshot({ path: testInfo.outputPath('ukmto-french-settings.png') });
});

for (const state of ['fresh', 'stale', 'empty', 'unavailable'] as const) {
  test(`UKMTO panel shows ${state} source state`, async ({ page }, testInfo) => {
    await seedAnonymousDashboard(page, 'full', {
      initializeOnce: {
        sessionKey: '__ukmto_test__', clearStorage: true,
        localStorage: {
          'worldmonitor-panels': JSON.stringify({ 'ukmto-incidents': { name: 'UKMTO Incidents', enabled: true, priority: 1 } }),
        },
      },
    });
    const now = Date.now();
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    const incident = {
      id: 'ukmto-143', incidentNumber: 143,
      incidentType: 'Suspicious Activity', place: 'Strait of Hormuz',
      description: 'Test report. Master reported a suspicious approach. <img src=x onerror=alert(1)>',
      occurredAt: now - 3600000, reportedAt: 0,
      location: { latitude: 26.43, longitude: 56.48 },
    };
    await page.route('**/api/bootstrap**', route => route.fulfill({ json: { data: state === 'unavailable' ? {} : {
      ukmtoIncidents: { incidents: state === 'empty' ? [] : [incident], fetchedAt: now - (state === 'stale' ? 80 * 60000 : 0), dataAvailable: true },
    } } }));
    await page.goto('/');
    const panel = page.locator('.panel[data-panel="ukmto-incidents"]');
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    if (state === 'fresh' || state === 'stale') {
      await expect(panel.getByRole('button', { name: /UKMTO 143/ })).toBeVisible();
      await expect(panel.locator('.ukmto-status')).toContainText(state === 'stale' ? 'Stale' : 'Source checked');
      await expect(panel.locator('.ukmto-incident img')).toHaveCount(0);
      await expect(panel.locator('.ukmto-attribution a[href="https://hormuz.data-tracking.net/"]')).toBeVisible();
      await expect(panel.locator('.ukmto-dates')).not.toContainText('Published');
      await panel.getByRole('button', { name: /UKMTO 143/ }).click();
    } else {
      await expect(panel).toContainText(state === 'empty' ? 'No incidents' : 'unavailable');
    }
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: testInfo.outputPath(`ukmto-${state}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath(`ukmto-${state}-mobile.png`) });
  });
}

test('UKMTO markers follow the Ships toggle in each renderer', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/tests/map-harness.html');
  const results = await page.evaluate(async () => {
    const modulePaths = ['/src/components/DeckGLMap.ts', '/src/components/Map.ts', '/src/components/GlobeMap.ts'];
    const result = [];
    for (const path of modulePaths) {
      const exports = await import(/* @vite-ignore */ path);
      const Constructor = exports.DeckGLMap ?? exports.MapComponent ?? exports.GlobeMap;
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;inset:0;width:1000px;height:700px;z-index:9999';
      document.body.append(container);
      const map = new Constructor(container, { view: 'global', layers: { ais: true }, timeRange: 'all', zoom: 2, pan: { x: 0, y: 0 } });
      if (map.whenReady) await map.whenReady();
      const incident = {
        id: 'fixture', incidentNumber: 143, incidentType: 'Suspicious Activity', place: 'Hormuz',
        description: '<img src=x> suspected approach', occurredAt: Date.now() - 7200000,
        reportedAt: Date.now(), location: { latitude: 26.43, longitude: 56.48 }, stale: false,
      };
      map.setUkmtoIncidents([incident]);
      const count = () => exports.DeckGLMap
        ? map.buildLayers().find((layer: { id: string }) => layer.id === 'ukmto-incidents-layer')?.props.data.length ?? 0
        : exports.GlobeMap ? map.globe.htmlElementsData().filter((item: { _kind: string }) => item._kind === 'ukmtoIncident').length
          : container.querySelectorAll('.ukmto-marker').length;
      const waitForCount = async (expected: number) => {
        const deadline = performance.now() + 5000;
        while (count() !== expected && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      };
      await waitForCount(1);
      const enabled = count();
      map.setLayers({ ais: false });
      await waitForCount(0);
      const disabled = count();
      map.setLayers({ ais: true });
      await waitForCount(1);
      const reenabled = count();
      map.setTimeRange('1h');
      await waitForCount(0);
      const outsideTimeRange = count();
      result.push({ path, enabled, disabled, reenabled, outsideTimeRange });
      map.destroy();
      container.remove();
    }
    return result;
  });
  for (const result of results) {
    expect(result, result.path).toMatchObject({ enabled: 1, disabled: 0, reenabled: 1, outsideTimeRange: 0 });
  }
});

test('UKMTO map status distinguishes empty and unavailable with the report panel absent', async ({ page }, testInfo) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/tests/map-harness.html');
  await page.evaluate(async () => {
    const modulePath = '/src/components/MapContainer.ts';
    const i18nPath = '/src/services/i18n.ts';
    await (await import(/* @vite-ignore */ i18nPath)).initI18n({ waitForFullTranslation: true });
    const { MapContainer } = await import(/* @vite-ignore */ modulePath);
    const host = document.createElement('div');
    host.id = 'ukmto-map-proof';
    host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9999';
    document.body.append(host);
    const map = new MapContainer(host, { view: 'global', layers: { ais: true }, timeRange: 'all', zoom: 2, pan: { x: 0, y: 0 } });
    (window as any).__ukmtoMap = map;
    map.setUkmtoSnapshot({ incidents: [], fetchedAt: Date.now(), dataAvailable: true, stale: false });
  });
  const status = page.locator('#ukmto-map-proof .ukmto-map-status');
  await expect(page.locator('#ukmto-map-proof')).not.toHaveAttribute('aria-busy', 'true', { timeout: 20000 });
  await expect(status).toContainText('No incidents');
  await page.evaluate(() => (window as any).__ukmtoMap.setUkmtoSnapshot({ incidents: [], fetchedAt: 0, dataAvailable: false, stale: false }));
  await expect(status).toContainText('unavailable');
  await page.locator('#ukmto-map-proof').screenshot({ path: testInfo.outputPath('ukmto-map-unavailable.png') });
  await page.evaluate(() => (window as any).__ukmtoMap.setLayers({ ais: false }));
  await expect(status).toHaveCount(0);
  await page.evaluate(() => (window as any).__ukmtoMap.setLayers({ ais: true }));
  await expect(status).toContainText('unavailable');
  await page.evaluate(() => (window as any).__ukmtoMap.destroy());
});
