import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { no2ActivityDataset } from '../../../../tests/helpers/no2-activity-fixture.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// Industrial activity (NO2) layer: prove the opt-in route is read only once
// the layer is on and only on deck.gl, that the legend carries the Copernicus
// credit, hover a country for its card, and toggle off.
// The harness runs under plain node, so the TypeScript handler is driven in a
// tsx child process: the body the browser receives is what the real route
// serves for the shared fixture, with no second projection to drift.
function routeBody(dataset) {
  const code = `
    import { getNo2Activity } from './server/worldmonitor/economic/v1/get-no2-activity.ts';
    const dataset = JSON.parse(process.argv[1]);
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.verify.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'verify';
    globalThis.fetch = async () => Response.json({ result: JSON.stringify(dataset) });
    process.stdout.write(JSON.stringify(await getNo2Activity({}, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' })));
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(dataset)], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.toString());
}

export default async function ({ page, base, shot, log }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });

  const now = Date.now();
  const dataset = no2ActivityDataset({
    generatedAt: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now - 4 * 86_400_000).toISOString().slice(0, 10),
    changes: { 'country-cn': 14.2, 'yangtze-river-delta': 18.5, 'jing-jin-ji': -12.1, 'country-de': -13.4, 'country-fr': 'pending', 'country-gb': null, 'country-us': 1.5, 'country-in': 'pending', 'country-br': 'pending' },
  });
  const body = routeBody(dataset);
  assert.equal(body.unavailableReason, 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED', 'the real handler must serve the fixture');
  assert.equal(body.regions.length, Object.keys(dataset.regions).length);

  let requests = 0;
  await page.route('**/api/economic/v1/get-no2-activity*', async (route) => {
    requests += 1;
    return route.fulfill({ json: body });
  });
  // The basemap hosts allow only production origins, so a local drive renders
  // the overlay on a blank map. Re-serve them with a CORS header for evidence.
  await page.route(/r2\.dev\/.*\.pmtiles|maps\.worldmonitor\.app\//, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });

  await seedProfile(page);
  const [lon, lat] = (process.env.WM_VERIFY_CENTER?.split(',').map(Number)) ?? [105, 32];
  await page.goto(`${base}/dashboard?layers=hotspots&lat=${lat}&lon=${lon}&zoom=${process.env.WM_VERIFY_ZOOM ?? 3.2}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  if (mobile) await page.locator('[data-mobile-tab="map"]').click();
  const renderer = await waitForMap(page);
  log('SYNTHETIC replay of the shared NO2 fixture through the real handler', { regions: body.regions.length, renderer, mobile });
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
  await page.waitForFunction(() => Number(document.querySelector('#mapContainer')?.dataset.wmCountryBoundaries) > 0, null, { timeout: 60_000 })
    .catch(() => { throw new Error('country boundaries never loaded; the choropleth has nothing to paint onto'); });
  const markers = await page.evaluate(() => ({ ...document.querySelector('#mapContainer')?.dataset }));
  log('deck markers', JSON.stringify(markers));
  assert.ok(Number(markers.wmNo2Regions) > 0, 'the map received the NO2 regions');
  assert.ok(Number(markers.wmNo2Countries) > 0, 'the map indexed the country regions');
  await page.waitForTimeout(1500);
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
}
