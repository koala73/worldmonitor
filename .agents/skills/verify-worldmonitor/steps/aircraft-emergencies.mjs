import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMERGENCY_CODES } from '../../../../shared/aircraft-emergencies.ts';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

export default async function ({ page, base, shot, log }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  const currentOnly = process.env.WM_VERIFY_CURRENT_ONLY === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/aircraft-emergencies/synthetic.json', import.meta.url), 'utf8'));
  const now = fixture.now;
  if (currentOnly) await page.clock.setFixedTime(new Date(now));
  else await page.clock.install({ time: new Date(now) });
  const observations = fixture.ac.map(row => ({
    address: row.hex, squawk: row.squawk, source: 'adsb.lol', observedAt: now - 2000,
    position: { lat: row.lat, lon: row.lon, observedAt: now - 3000 },
    callsign: row.flight, registration: row.r || '', aircraftType: row.t || '', description: '',
    militaryFlag: row.dbFlags ? 'set' : 'not_set', altitudeFt: row.alt_baro, groundSpeedKts: row.gs,
  }));
  const feeds = EMERGENCY_CODES.map(squawk => ({ source: 'adsb.lol', squawk, status: 'available', fetchedAt: now, message: '' }));
  let body = { observations, feeds };
  let failed = false;
  let refreshFeedClocks = false;
  let requests = 0;
  await page.route('**/api/aviation/v1/list-aircraft-emergencies*', async route => {
    requests += 1;
    if (failed) return route.fulfill({ status: 503, body: 'unavailable' });
    const receipt = refreshFeedClocks ? await page.evaluate(() => Date.now()) : 0;
    return route.fulfill({ json: receipt ? { ...body, feeds: body.feeds.map(feed => ({ ...feed, fetchedAt: receipt })) } : body });
  });
  await seedProfile(page);
  await page.goto(`${base}/dashboard?layers=hotspots`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  if (mobile) await page.locator('[data-mobile-tab="map"]').click();
  const renderer = await waitForMap(page);
  if (currentOnly && renderer === 'deckgl') await page.locator('#deckgl-basemap .maplibregl-ctrl-top-left > div:empty').first().waitFor({ state: 'attached', timeout: 30_000 });
  if (!currentOnly) { await page.clock.runFor(2000); await page.clock.resume(); }
  log('SYNTHETIC browser replay', { mobile, renderer });
  await shot('before-enable');
  const toggle = page.locator('.layer-toggle[data-layer="aircraftEmergencies"]');
  const toggleLayer = async () => {
    if (!mobile) { await toggle.click(); return; }
    await page.locator('[data-mobile-tab="search"]').click();
    await page.locator('.search-overlay .search-input').fill('Aircraft emergencies');
    await page.locator('.search-result-item[data-index]').filter({ hasText: 'Aircraft emergencies' }).first().click();
    await page.locator('[data-mobile-tab="map"]').click();
  };
  await toggleLayer();
  const layer = page.locator('.aircraft-emergency-layer');
  await layer.getByText('6 reported aircraft', { exact: true }).waitFor();
  assert.equal(await layer.locator('button[data-aircraft-emergency]').count(), 6);
  await page.waitForFunction(() => location.search.includes('aircraftEmergencies') && JSON.parse(localStorage.getItem('worldmonitor-layers')).aircraftEmergencies === true);
  if (currentOnly && renderer === 'deckgl' && !mobile) {
    await page.mouse.click(122, 435);
    await layer.getByText('RCH7500', { exact: true }).waitFor();
    log('Picked the synthetic Washington aircraft from the rendered map');
  }
  await layer.locator('[data-aircraft-emergency="a00001"]').click();
  await layer.getByText('7500 · Unlawful interference signal', { exact: true }).waitFor();
  await layer.getByText('SYNTH-1', { exact: true }).waitFor();
  await shot('7500-details');
  for (const [address, condition] of [['a00002', 'Radio communication failure signal'], ['ae0003', 'General emergency signal']]) {
    await layer.locator(`[data-aircraft-emergency="${address}"]`).click();
    await layer.getByText(new RegExp(condition)).waitFor();
  }
  await shot('7700-military-details');
  if (currentOnly) {
    log('Current signal details passed with native render timers', { mobile, renderer });
    return;
  }
  if (renderer === 'svg') {
    await page.clock.runFor(500);
    await page.clock.resume();
    await page.waitForFunction(() => document.querySelectorAll('.aircraft-emergency-marker').length === 6);
  }

  body = { observations: [{ ...observations[0], squawk: '7600', observedAt: 0 }], feeds: feeds.map(feed => ({ ...feed, fetchedAt: now + 60_000 })) };
  await page.clock.runFor(65_000);
  await layer.locator('[data-aircraft-emergency="a00001"]').click();
  await layer.getByText('Conflicting code reports. Current condition unknown.', { exact: true }).waitFor();
  await layer.getByText('7500 · Unlawful interference signal', { exact: true }).waitFor();
  await layer.getByText('7600 · Radio communication failure signal', { exact: true }).waitFor();
  await shot('undated-code-conflict');

  const changed = { ...observations[0], squawk: '7600', observedAt: now + 60_000, position: undefined };
  body = { observations: [changed, observations[1], { ...observations[1], squawk: '7700', source: 'synthetic-conflict' }], feeds: feeds.map(feed => ({ ...feed, fetchedAt: now + 60_000 })) };
  const initialRequests = requests;
  await page.clock.fastForward(65_000);
  await page.waitForFunction(() => {
    const label = document.querySelector('[data-aircraft-emergency="a00001"]')?.textContent ?? '';
    return label.startsWith('7600') && label.includes('current');
  });
  assert.ok(requests > initialRequests);
  const changedButton = layer.locator('[data-aircraft-emergency="a00001"]');
  if (await changedButton.getAttribute('aria-expanded') !== 'true') await changedButton.click();
  await layer.getByText('Position time', { exact: true }).waitFor();
  assert.match(await layer.innerText(), /stale or unknown/);
  await layer.locator('[data-aircraft-emergency="a00002"]').click();
  await layer.getByText('Conflicting code reports. Current condition unknown.', { exact: true }).waitFor();
  await shot('conflict-and-missing-position');
  if (renderer === 'svg') {
    await page.clock.runFor(500);
    await page.clock.resume();
    await page.waitForFunction(() => document.querySelectorAll('.aircraft-emergency-marker').length === 0);
  }

  failed = true;
  await page.clock.fastForward(65_000);
  await layer.getByText('Aircraft data unavailable or stale.', { exact: true }).waitFor();
  assert.equal(await layer.locator('button').filter({ hasText: 'current' }).count(), 0);
  await shot('feed-unavailable');
  await page.clock.fastForward(16 * 60_000);
  await page.waitForFunction(() => document.querySelectorAll('.aircraft-emergency-layer button').length === 0);
  failed = false;
  const later = await page.evaluate(() => Date.now());
  body = { observations: [], feeds: feeds.map(feed => ({ ...feed, fetchedAt: later })) };
  const emptyResponse = page.waitForResponse(response => response.url().includes('/api/aviation/v1/list-aircraft-emergencies') && response.status() === 200);
  await page.clock.runFor(65_000);
  await emptyResponse;
  await layer.getByText('No matching squawks reported by this feed', { exact: true }).waitFor();
  await shot('successful-empty');
  refreshFeedClocks = true;
  body = { observations: [{ ...observations[0], observedAt: 0, position: undefined }], feeds };
  await page.clock.runFor(65_000);
  await layer.getByText('1 reported aircraft', { exact: true }).waitFor();
  await page.clock.fastForward(16 * 60_000);
  await page.clock.runFor(65_000);
  await layer.getByText('No current aircraft reports. Stale or unknown observations have expired.', { exact: true }).waitFor();
  assert.equal(await layer.locator('button[data-aircraft-emergency]').count(), 0, 'repeated unknown-clock reports stay expired');
  await shot('unknown-clock-expired');
  await toggleLayer();
  await layer.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !location.search.includes('aircraftEmergencies') && JSON.parse(localStorage.getItem('worldmonitor-layers')).aircraftEmergencies === false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForBoot(page);
  assert.equal(await page.locator('.aircraft-emergency-layer:visible').count(), 0);
  log('Assertions passed', { requests, renderer, mobile, codes: [...EMERGENCY_CODES], urlAndStorage: true, conflict: true, missingPosition: true, failure: true, expiry: true, empty: true });
}
