import assert from 'node:assert/strict';
import { no2ActivityDataset } from '../../../../tests/helpers/no2-activity-fixture.mjs';
import { getNo2Activity } from '../../../../server/worldmonitor/economic/v1/get-no2-activity.ts';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

// Industrial activity (NO2) layer: prove the opt-in route is read only once
// the layer is on and only on deck.gl, that the legend carries the Copernicus
// credit, hover a country and a cluster for their cards, and toggle off.
// The route body comes from the real handler over the shared fixture served
// through a fake Redis, so pending, excluded and reading states all appear.
export default async function ({ page, base, shot, log }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });

  const now = Date.now();
  const dataset = no2ActivityDataset({
    generatedAt: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now - 4 * 86_400_000).toISOString().slice(0, 10),
    changes: { 'country-cn': 14.2, 'yangtze-river-delta': 18.5, 'jing-jin-ji': -12.1, 'country-de': -13.4, 'country-fr': 'pending', 'country-gb': null, 'country-us': 1.5, 'country-in': 'pending', 'country-br': 'pending' },
  });
  const originalFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.verify.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'verify';
  globalThis.fetch = async (input, init) => (String(input).startsWith('https://redis.verify.invalid/')
    ? Response.json({ result: JSON.stringify(dataset) })
    : originalFetch(input, init));

  let requests = 0;
  await page.route('**/api/economic/v1/get-no2-activity*', async (route) => {
    requests += 1;
    const url = new URL(route.request().url());
    const body = await getNo2Activity({}, {
      countryCode: url.searchParams.get('country_code') ?? '',
      regionId: url.searchParams.get('region_id') ?? '',
      kind: url.searchParams.get('kind') ?? 'NO2_REGION_KIND_UNSPECIFIED',
    });
    return route.fulfill({ json: body });
  });
  await page.route(/r2\.dev\/.*\.pmtiles|maps\.worldmonitor\.app\//, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });

  try {
    await seedProfile(page);
    const [lon, lat] = (process.env.WM_VERIFY_CENTER?.split(',').map(Number)) ?? [105, 32];
    await page.goto(`${base}/dashboard?layers=hotspots&lat=${lat}&lon=${lon}&zoom=${process.env.WM_VERIFY_ZOOM ?? 3.2}`, { waitUntil: 'domcontentloaded' });
    await waitForBoot(page);
    if (mobile) await page.locator('[data-mobile-tab="map"]').click();
    const renderer = await waitForMap(page);
    log('SYNTHETIC replay of the shared NO2 fixture through the real handler', { regions: Object.keys(dataset.regions).length, renderer, mobile });
    assert.equal(requests, 0, 'the opt-in route must not be read while the layer is off');
    await shot('before-enable');

    const toggleLayer = async () => {
      if (!mobile) { await page.locator('.layer-toggle[data-layer="no2Activity"]').click(); return; }
      await page.locator('[data-mobile-tab="search"]').click();
      await page.locator('.search-overlay .search-input').fill('NO2');
      await page.locator('.search-result-item[data-command="layer:no2Activity"]').first().click();
      await page.locator('[data-mobile-tab="map"]').click();
    };

    if (renderer !== 'deckgl') {
      assert.equal(await page.locator('.layer-toggle[data-layer="no2Activity"]').count(), 0, 'the layer is deck.gl only and must not be offered on this renderer');
      await shot('not-offered');
      log('Assertions passed: layer not offered outside deck.gl', { renderer, mobile });
      return;
    }

    await toggleLayer();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('worldmonitor-layers') || '{}').no2Activity === true);
    for (let i = 0; i < 100 && requests === 0; i++) await page.waitForTimeout(100);
    assert.ok(requests >= 1, 'enabling the layer reads the route');
    await page.waitForTimeout(1500);
    const legend = page.locator('#no2ActivityLegend');
    await legend.waitFor({ state: 'visible', timeout: 10_000 });
    const legendText = await legend.innerText();
    for (const label of ['Strengthening', 'Weakening', 'Unchanged', 'Baseline pending', 'No reading', 'Contains modified Copernicus Sentinel data']) {
      assert.ok(legendText.includes(label), `legend must show "${label}"`);
    }
    await shot('enabled');

    if (!mobile && !process.env.WM_VERIFY_CENTER) {
      const box = await page.locator('#mapContainer').boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
      const country = page.locator('.deckgl-tooltip').filter({ hasText: 'NO2 activity' });
      await country.first().waitFor({ timeout: 10_000 });
      const countryText = await country.first().innerText();
      assert.match(countryText, /Contains modified Copernicus Sentinel data/);
      log('country card', countryText);
      await shot('country-card');
    }

    await toggleLayer();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('worldmonitor-layers')).no2Activity === false);
    await page.waitForTimeout(800);
    assert.equal(await legend.isVisible(), false, 'legend hides with the layer');
    await shot('disabled');
    log('Assertions passed', { requests, renderer, mobile });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
