import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyFeatures } from '../../../../scripts/lib/nms-notam.mjs';
import { buildPayload } from '../../../../scripts/seed-notam-nms.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

// NOTAM airspace areas on the Aviation layer: toggle Aviation on, prove the
// on-demand key is fetched only then (and never on SVG), hover a drawn
// restriction for its tooltip, and toggle it off.
// The payload is built from tests/fixtures/nms-notam-geojson.json with the
// seeder's own functions. WM_VERIFY_NOTAM_FIXTURE may point at a larger payload
// (the `aviation:notam:airspace:v1` shape) for density screenshots.
export default async function ({ page, base, shot, log }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });

  let payload;
  if (process.env.WM_VERIFY_NOTAM_FIXTURE) {
    payload = JSON.parse(readFileSync(process.env.WM_VERIFY_NOTAM_FIXTURE, 'utf8'));
  } else {
    const { features } = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/nms-notam-geojson.json', import.meta.url), 'utf8'));
    // Inside every active fixture's effective window (tests/notam-nms.test.mjs NOW).
    const nowMs = Date.parse('2026-10-24T14:48:00Z');
    const items = {};
    applyFeatures(items, Object.values(features), nowMs);
    const { closures: _closures, ...rest } = buildPayload({ items }, nowMs);
    payload = rest;
  }
  assert.ok(payload.notams.length > 0, 'fixture must produce airspace rows');
  const focus = payload.notams.find((row) => row.radiusNm) ?? payload.notams[0];
  // NMS staging ships polygons only on runway and movement-area NOTAMs, which
  // are not airspace, so add one SYNTHETIC polygon to exercise that renderer.
  const [flon, flat] = focus.center;
  const d = 0.25;
  payload = {
    ...payload,
    notams: [...payload.notams, {
      ...focus, id: 'SYNTHETIC_POLYGON', kind: 'restricted', number: 'SYNTH/26', radiusNm: undefined,
      center: [flon + 3 * d, flat], text: 'SYNTHETIC POLYGON ROW FOR RENDERER CHECK',
      polygons: [[[flon + 2 * d, flat - d], [flon + 4 * d, flat - d], [flon + 4 * d, flat + d], [flon + 2 * d, flat + d], [flon + 2 * d, flat - d]]],
    }],
  };

  // The basemap hosts allow only production origins, so a local drive renders
  // the overlay on a blank map. Re-serve them with a CORS header for evidence.
  await page.route(/r2\.dev\/.*\.pmtiles|maps\.worldmonitor\.app\//, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });

  let requests = 0;
  await page.route('**/api/bootstrap?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('keys') !== 'notamAirspace') return route.fallback();
    requests += 1;
    return route.fulfill({ json: { data: { notamAirspace: payload } } });
  });

  await seedProfile(page);
  // WM_VERIFY_CENTER="lon,lat" frames a region instead (no tooltip check).
  const center = process.env.WM_VERIFY_CENTER?.split(',').map(Number);
  const [lon, lat] = center ?? focus.center;
  await page.goto(`${base}/dashboard?layers=hotspots&lat=${lat}&lon=${lon}&zoom=${process.env.WM_VERIFY_ZOOM ?? 9}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  if (mobile) await page.locator('[data-mobile-tab="map"]').click();
  const renderer = await waitForMap(page);
  log('SYNTHETIC replay of FAA NMS fixture rows', { rows: payload.notams.length, focus: focus.id, kind: focus.kind, renderer, mobile });
  assert.equal(requests, 0, 'the on-demand key must not be fetched while Aviation is off');
  await shot('before-enable');

  // NOTAM areas belong to the Aviation (flights) layer, which every renderer
  // offers. Only deck.gl draws the areas: on the SVG renderer (the mobile
  // default and any browser without WebGL) Aviation must not fetch them.
  const layersState = () => page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-layers') || '{}'));
  const toggleLayer = async () => {
    if (!mobile) { await page.locator('.layer-toggle[data-layer="flights"]').click(); return; }
    await page.locator('[data-mobile-tab="search"]').click();
    await page.locator('.search-overlay .search-input').fill('NOTAM');
    await page.locator('.search-result-item[data-command="layer:flights"]').first().click();
    await page.locator('[data-mobile-tab="map"]').click();
  };
  assert.equal(await page.locator('.layer-toggle[data-layer="notamAirspace"]').count(), 0, 'no separate NOTAM toggle');
  await toggleLayer();
  await page.waitForFunction(() => /[?&]layers=[^&]*flights/.test(location.search)
    && JSON.parse(localStorage.getItem('worldmonitor-layers')).flights === true);

  if (renderer === 'svg') {
    await page.waitForTimeout(3000);
    assert.equal(requests, 0, 'the SVG renderer does not fetch NOTAM areas');
    await shot('svg-aviation-on');
    log('Assertions passed: Aviation on SVG fetches no NOTAM areas', { renderer, mobile, layers: await layersState() });
    return;
  }

  for (let i = 0; i < 100 && requests === 0; i++) await page.waitForTimeout(100);
  assert.ok(requests >= 1, 'enabling Aviation fetches notamAirspace');
  await page.waitForTimeout(1500); // deck.gl paints on the next animation frames
  await shot('enabled');

  if (renderer === 'deckgl' && !mobile && !center) {
    const box = await page.locator('#mapContainer').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tooltip = page.locator('.deckgl-tooltip').filter({ hasText: 'Source: FAA NMS' });
    await tooltip.first().waitFor({ timeout: 10_000 });
    const text = await tooltip.first().innerText();
    assert.match(text, new RegExp(focus.number.replace(/[/]/g, '\\/')));
    log('tooltip', text);
    await shot('tooltip');
  }

  await toggleLayer();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('worldmonitor-layers')).flights === false);
  await page.waitForTimeout(1000);
  await shot('disabled');
  log('Assertions passed', { requests, renderer, mobile });
}
