import { expect, test } from '@playwright/test';
import type { DisplacementEventsData, DisplacementFlow, InternalDisplacementData } from '../src/services/displacement';

type Harness = {
  ready: boolean;
  setOverlayZoom: (zoom: number) => void;
  setOverlayViewport: (lat: number, lon: number) => void;
  forceRender: () => void;
  setDisplacementFlows: (data: DisplacementFlow[]) => void;
  setDisplacementEvents: (data: DisplacementEventsData) => void;
  setInternalDisplacement: (data: InternalDisplacementData) => void;
  toggleCrossBorderLayer: () => void;
};
const internal: InternalDisplacementData = {
  operations: [],
  regions: [{ pcode: 'SD01', name: 'Khartoum', countryName: 'Sudan', operation: 'Controlled DTM round', reportingDate: '2026-10-01', idps: 12000, lat: 15, lon: 32 }],
  routes: [{ originName: 'Khartoum', destinationName: 'Darfur', countryName: 'Sudan', operation: 'Controlled DTM round', reportingDate: '2026-10-01', idps: 2300, originLat: 15, originLon: 32, destinationLat: 12, destinationLon: 24 }],
};
const events: DisplacementEventsData = {
  countries: [], missingCountries: [], asOf: '2026-11-01',
  points: [{ id: 'test-event', countryCode: 'ESP', countryName: 'Spain', conflict: false, figure: 900, displacementDate: '2026-10-15', eventName: 'Controlled flood <report>', hazardType: 'Flood', locationName: 'Madrid', lat: 40, lon: -4 }],
};
const flows: DisplacementFlow[] = [{ originCode: 'UKR', originName: 'Ukraine', asylumCode: 'DEU', asylumName: 'Germany', refugees: 34000, originLat: 49, originLon: 32, asylumLat: 51, asylumLon: 10 }];

for (const width of [390, 1280]) {
  test.describe(`SVG displacement (${width}px)`, () => {
    test.use({ hasTouch: true, isMobile: width < 600, viewport: { width, height: 844 } });
    test('renders all missing feeds, opens source details and clears on toggle or empty refresh', async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
      await page.waitForFunction(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness?.ready);
      await page.evaluate(({ internal, events, flows }) => {
        const harness = (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness;
        harness.setInternalDisplacement(internal);
        harness.setDisplacementEvents(events);
        harness.setDisplacementFlows(flows);
      }, { internal, events, flows });
      await expect(page.locator('.displacement-marker')).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness.toggleCrossBorderLayer());
      await expect(page.locator('.displacement-marker')).toHaveCount(4);
      await expect(page.locator('.displacement-route')).toHaveCount(2);
      for (const [kind, text, source, lat, lon] of [
        ['idmc', 'Controlled flood <report>', 'IDMC', 40, -4],
        ['dtm-region', '12,000', 'IOM DTM', 15, 32],
        ['dtm-route', '2,300', 'IOM DTM', 13.5, 28],
        ['unhcr', '34,000', 'UNHCR', 50, 21],
      ] as const) {
        await page.evaluate(({ lat, lon }) => {
          const h = (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness;
          h.setOverlayZoom(8);
          h.setOverlayViewport(lat, lon);
        }, { lat, lon });
        await page.locator(`.displacement-${kind}`).tap();
        const popup = page.locator('.map-popup');
        await expect(popup).toBeVisible();
        await expect(popup).toContainText(text!);
        await expect(popup).toContainText(source!);
        expect(await popup.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await popup.locator('.popup-close').tap();
      }
      await page.evaluate(() => {
        const h = (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness;
        h.setOverlayZoom(2.7); h.setOverlayViewport(25, 15); h.forceRender(); h.forceRender();
      });
      await expect(page.locator('.displacement-route')).toHaveCount(2);
      await expect.poll(async () => (await page.locator('.displacement-unhcr').boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(38);
      await page.screenshot({ path: testInfo.outputPath(`displacement-${width}.png`) });
      await page.evaluate(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness.toggleCrossBorderLayer());
      await expect(page.locator('.displacement-marker, .displacement-route')).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness.toggleCrossBorderLayer());
      await expect(page.locator('.displacement-marker')).toHaveCount(4);
      await page.evaluate(() => {
        const harness = (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness;
        harness.setInternalDisplacement({ operations: [], regions: [], routes: [] });
        harness.setDisplacementEvents({ countries: [], points: [], missingCountries: [], asOf: '' });
        harness.setDisplacementFlows([]);
      });
      await expect(page.locator('.displacement-marker, .displacement-route')).toHaveCount(0);
      // Thousands of IDMC figures share the existing per-feed marker cap.
      await page.evaluate(events => {
        const h = (window as unknown as { __mobileMapIntegrationHarness: Harness }).__mobileMapIntegrationHarness;
        h.setDisplacementEvents({ ...events, points: Array.from({ length: 1000 }, (_, i) => ({ ...events.points[0]!, id: String(i), figure: i + 1 })) });
      }, events);
      await expect(page.locator('.displacement-idmc')).toHaveCount(150);
      await expect(page.locator('.layer-toggle-row[data-layer="displacement"] .layer-truncation-count')).toHaveText('150/1000');
      expect(errors).toEqual([]);
    });
  });
}

test.describe('Dashboard displacement data path', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('loads IDMC bootstrap and DTM/UNHCR RPC data into the SVG map from a shared layer URL', async ({ page }, testInfo) => {
    const { seedAnonymousDashboard } = await import('./bootstrap-request-budget-fixtures');
    await seedAnonymousDashboard(page, 'full', { localStorage: {
      // Keep coverage of shared links for viewers who saved a collapsed map.
      'mobile-map-collapsed': 'true',
      'worldmonitor-panels': JSON.stringify({ displacement: { name: 'Displacement', enabled: true, priority: 0 } }),
    } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:\d+|localhost:\d+)(?:\/|$)).*/i, route => route.abort());
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', route => route.fulfill({ json: { missing: [], data: {
      idmcIduDisplacement: { windowFrom: '2026-05-06', missingCountries: [], countries: [], events: [{
        id: 'test-event', countryCode: 'ESP', countryName: 'Spain', displacementType: 'Disaster', figure: 900,
        displacementDate: '2026-10-15', eventName: 'Controlled flood', hazardType: 'Flood', locationName: 'Madrid',
        location: { latitude: 40, longitude: -4 },
      }] },
    } } }));
    await page.route(/get-internal-displacement/, route => route.fulfill({ json: { fetchedAt: Date.now(), dataAvailable: true, operations: [{
      countryCode: 'SDN', countryName: 'Sudan', operation: 'Controlled DTM round', reportingDate: '2026-10-01', totalIdps: 12000, reasons: [],
      regions: [{ pcode: 'SD01', name: 'Khartoum', idps: 12000, location: { latitude: 15, longitude: 32 } }],
      flows: [{ originPcode: 'SD01', originName: 'Khartoum', destinationPcode: 'SD02', destinationName: 'Darfur', idps: 2300,
        originLocation: { latitude: 15, longitude: 32 }, destinationLocation: { latitude: 12, longitude: 24 } }],
    }] } }));
    await page.route(/get-displacement-summary/, route => route.fulfill({ json: { fetchedAt: Date.now(), dataAvailable: true, summary: {
      year: 2025, countries: [{ code: 'UKR', name: 'Ukraine', refugees: 34000, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 34000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0 }],
      globalTotals: { refugees: 34000, asylumSeekers: 0, idps: 0, stateless: 0, total: 34000 },
      topFlows: [{ originCode: 'UKR', originName: 'Ukraine', asylumCode: 'DEU', asylumName: 'Germany', refugees: 34000,
        originLocation: { latitude: 49, longitude: 32 }, asylumLocation: { latitude: 51, longitude: 10 } }],
    } } }));
    await page.goto('/dashboard?layers=displacement&lat=25&lon=15&zoom=2.7');
    await page.locator('.map-collapse-btn').click();
    await expect(page.locator('#mapContainer.svg-mode')).toBeVisible();
    await expect(page.locator('.displacement-marker')).toHaveCount(4);
    await expect(page.locator('.displacement-route')).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true');
    await page.locator('.displacement-idmc').tap();
    await expect(page.locator('.map-popup')).toContainText('Controlled flood');
    await expect(page.locator('.map-popup')).toContainText('IDMC');
    await expect(page.locator('.map-popup .popup-body')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('dashboard-mobile-idmc.png') });
    await page.locator('.map-popup .popup-close').tap();
    await page.reload();
    if (await page.locator('#mapSection').evaluate(el => el.classList.contains('collapsed'))) await page.locator('.map-collapse-btn').click();
    await expect(page.locator('.displacement-marker')).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath('dashboard-mobile-displacement.png') });
  });
});
