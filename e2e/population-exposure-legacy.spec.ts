import { expect, test } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

for (const refreshed of [false, true]) {
  test(`population exposure handles ${refreshed ? 'current' : 'legacy'} bootstrap fields`, async ({ page }, testInfo) => {
    await seedAnonymousDashboard(page, 'full', { localStorage: {
      'worldmonitor-panels': JSON.stringify({ 'population-exposure': { name: 'Population Exposure', enabled: true, priority: 0 } }),
    } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:\d+|localhost:\d+)(?:\/|$)).*/i, route => route.abort());
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    const point = {
      id: 'taiz', country: 'Yemen', locationName: 'Taiz', location: { latitude: 13.58, longitude: 44.02 },
      dateStart: Date.now(), dateEnd: Date.now(), sideA: 'A', sideB: 'B', deathsBest: 0, deathsLow: 0, deathsHigh: 0,
      violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', sourceOriginal: 'Test data',
      ...(refreshed ? { hasPreciseLocation: true } : {}),
    };
    await page.route('**/api/bootstrap*', route => route.fulfill({ json: { missing: [], data: {
      ucdpEvents: {
        events: [point, { ...point, id: 'broad', locationName: 'Excluded broad location', hasPreciseLocation: false }],
        ...(refreshed ? {
          exposureEvents: [{ ...point, exposureEventCount: 2 }],
          exposureCoverage: { totalEvents: 3, withoutPreciseLocation: 1, withoutEstimate: 0, atOtherPlaces: 0 },
        } : {}),
      },
      unrestEvents: { events: [{
        id: 'aden', title: 'Test unrest', city: 'Aden', country: 'Yemen', location: { latitude: 12.8, longitude: 45 },
        hasPreciseLocation: true, sourceType: 'UNREST_SOURCE_TYPE_ACLED', occurredAt: Date.now(),
        eventType: 'UNREST_EVENT_TYPE_PROTEST', severity: 'UNREST_SEVERITY_LOW',
        confidence: 'UNREST_CONFIDENCE_HIGH', fatalities: 0, sources: [], tags: [], actors: [],
      }] },
    } } }));
    await page.goto('/dashboard?lang=en');
    const panel = page.locator('#panelsGrid .panel[data-panel="population-exposure"]');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('.popexp-card')).toHaveCount(2);
    await expect(panel).toContainText('Taiz, Yemen');
    await expect(panel).toContainText('Aden, Yemen');
    await expect(panel).not.toContainText('Excluded broad location');
    if (refreshed) {
      await expect(panel).toContainText('Events shown: 3 of 4');
      await expect(panel).toContainText('2 events');
      await expect(panel.locator('.popexp-panel-content')).not.toContainText('pending update');
    } else {
      await expect(panel).toContainText('Location precision pending update');
      await expect(panel).toContainText('Unrest coverage');
      await expect(panel).toContainText('Events shown: 1 of 1');
      await expect(panel).toContainText('UCDP coverage pending update');
    }
    // Use the panel's keyboard resize control so the evidence includes the footer.
    await panel.locator('.panel-resize-handle').focus();
    await page.keyboard.press('ArrowDown');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.locator('.panel-content').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await panel.screenshot({ path: testInfo.outputPath(`exposure-${refreshed ? 'current' : 'legacy'}-${width}.png`) });
    }
  });
}
