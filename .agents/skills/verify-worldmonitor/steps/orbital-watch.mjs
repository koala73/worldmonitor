/**
 * Satellite passes here: right-click the globe, read the lookup sheet in each
 * state, and prove the picked point reaches only the public archives.
 *
 * WM_VERIFY_ORBITAL_CATALOG=live skips the catalog fixture and uses the local
 * API. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 */
import { readFileSync } from 'node:fs';
import { matchSensorProfile } from '../../../../shared/orbital/sensor-profiles.js';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';
const HOUR = 3_600_000;
const PLACE = { name: 'Palm Jumeirah, Dubai', lat: 25.112, lon: 55.139, zoom: 9 };

export function fixtureCatalog() {
  const { records } = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
  const satellites = records.flatMap((r) => {
    const profile = matchSensorProfile(r.NORAD_CAT_ID, r.OBJECT_NAME);
    if (!profile) return [];
    const elements = {
      objectName: r.OBJECT_NAME, objectId: r.OBJECT_ID, epoch: r.EPOCH, meanMotion: r.MEAN_MOTION, eccentricity: r.ECCENTRICITY,
      inclination: r.INCLINATION, raOfAscNode: r.RA_OF_ASC_NODE, argOfPericenter: r.ARG_OF_PERICENTER, meanAnomaly: r.MEAN_ANOMALY,
      ephemerisType: r.EPHEMERIS_TYPE ?? 0, classificationType: r.CLASSIFICATION_TYPE ?? 'U', noradCatId: Number(r.NORAD_CAT_ID),
      elementSetNo: r.ELEMENT_SET_NO ?? 999, revAtEpoch: r.REV_AT_EPOCH ?? 0, bstar: r.BSTAR ?? 0,
      meanMotionDot: r.MEAN_MOTION_DOT ?? 0, meanMotionDdot: r.MEAN_MOTION_DDOT ?? 0,
    };
    return [{ noradId: Number(r.NORAD_CAT_ID), name: r.OBJECT_NAME, profileId: profile.id, elements }];
  });
  return { inventoryVersion: 'verify-fixture', profiles: [], ring: [], fetchedAt: Date.now() - 2 * HOUR, source: 'fixture', stale: false, satellites };
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const fixture = process.env.WM_VERIFY_ORBITAL_CATALOG === 'live' ? null : fixtureCatalog();
  let catalog = fixture;
  if (fixture) await page.route(`**${CATALOG_PATH}*`, (route) => route.fulfill({ json: catalog }));

  let holdArchives = null;
  const failing = new Set();
  await page.route((url) => ARCHIVE_HOSTS.includes(url.hostname), async (route) => {
    if (holdArchives) await holdArchives;
    if (failing.has(new URL(route.request().url()).hostname)) return route.fulfill({ status: 503, body: 'unavailable' });
    return route.continue();
  });

  const requests = [];
  page.on('request', (req) => requests.push({
    url: req.url(), body: req.postData() ?? '', harnessNavigation: req.isNavigationRequest() && req.frame() === page.mainFrame(),
  }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard?view=global&lat=${PLACE.lat}&lon=${PLACE.lon}&zoom=${PLACE.zoom}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const sheet = page.locator('.orbital-watch-sheet');
  let aim = { dx: 0, dy: 0 };
  const open = async ({ dx, dy } = aim) => {
    const box = await page.locator('#mapContainer canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Satellite passes here' }).or(page.getByText('Satellite passes here', { exact: true })).first().click();
    await expectVisible('.orbital-watch-sheet');
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'mapContainer') throw new Error(`focus after close went to ${focused}`);
  };
  const settleImagesInView = async () => {
    await page.waitForFunction(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      return [...document.querySelectorAll('.orbital-watch-sheet .ow-tile')].every((tile) => {
        const r = tile.getBoundingClientRect();
        const offscreen = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0;
        return offscreen || tile.dataset.state !== 'loading';
      });
    }, null, { timeout: 90_000 });
    log('tile states', await sheet.locator('.ow-tile').evaluateAll((tiles) => tiles.map((t) => t.dataset.state).join('')));
  };
  const privacy = async () => {
    if (!(await sheet.locator('.ow-privacy').isVisible())) throw new Error('privacy notice missing');
  };

  const pickedAt = async (at) => {
    await open(at);
    const [lat, ns, lon, ew] = (await sheet.locator('.ow-place').innerText()).match(/([\d.]+)°([NS]) ([\d.]+)°([EW])/).slice(1);
    await close();
    return { lat: ns === 'N' ? +lat : -lat, lon: ew === 'E' ? +lon : -lon };
  };
  const settled = async () => {
    let prev = await pickedAt(aim);
    for (let tries = 0; tries < 12; tries++) {
      await page.waitForTimeout(1500);
      const now = await pickedAt(aim);
      if (Math.abs(now.lat - prev.lat) < 0.001 && Math.abs(now.lon - prev.lon) < 0.001) return now;
      prev = now;
    }
    return prev;
  };
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));
  const assertAtPlace = (text) => {
    const [lat, lon] = text.match(/[\d.]+/g).map(Number);
    if (Math.abs(lat - PLACE.lat) > 0.005 || Math.abs(lon - PLACE.lon) > 0.005) throw new Error(`picked ${text}, not ${PLACE.name}`);
  };
  const openAtPlace = async () => {
    await open();
    assertAtPlace(await sheet.locator('.ow-place').innerText());
  };
  const calibrate = async () => {
    for (let round = 0; round < 8; round++) {
      const here = await settled();
      if (Math.abs(here.lat - PLACE.lat) < 0.003 && Math.abs(here.lon - PLACE.lon) < 0.003) break;
      const right = await pickedAt({ dx: aim.dx + 40, dy: aim.dy });
      const down = await pickedAt({ dx: aim.dx, dy: aim.dy + 40 });
      const [a, b, c, d] = [(right.lat - here.lat) / 40, (down.lat - here.lat) / 40, (right.lon - here.lon) / 40, (down.lon - here.lon) / 40];
      const [dLat, dLon] = [PLACE.lat - here.lat, PLACE.lon - here.lon];
      const det = a * d - b * c;
      aim = { dx: aim.dx + (dLat * d - b * dLon) / det, dy: aim.dy + (a * dLon - c * dLat) / det };
      log('aim', JSON.stringify({ here, aim }));
      const box = await page.locator('#mapContainer canvas').first().boundingBox();
      if (Math.abs(aim.dx) > box.width * 0.35 || Math.abs(aim.dy) > box.height * 0.35) {
        const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
        const [mx, my] = [clamp(aim.dx, box.width * 0.3), clamp(aim.dy, box.height * 0.3)];
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - mx, cy - my, { steps: 25 });
        await page.mouse.up();
        aim = { dx: 0, dy: 0 };
      }
    }
  };
  await calibrate();

  let release;
  holdArchives = new Promise((resolve) => { release = resolve; });
  await open();
  const pointText = await sheet.locator('.ow-place').innerText();
  log('picked point', pointText, 'target', PLACE.name);
  assertAtPlace(pointText);
  await sheet.locator('.ow-step[data-status="running"]', { hasText: 'Archives' }).waitFor({ timeout: 90_000 });
  await privacy();
  if (await sheet.locator('.ow-headline').count()) throw new Error('results shown while archives pending');
  log('steps', (await sheet.locator('.ow-step').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  await shot('loading-compute-steps');
  holdArchives = null;
  release();
  await sheet.locator('.ow-headline').waitFor({ timeout: 90_000 });
  await privacy();
  log('headline', await sheet.locator('.ow-headline').innerText(), '|', await sheet.locator('.ow-subline').innerText());
  const hero = sheet.locator('.ow-card').first();
  log('hero', await hero.locator('.ow-card-tag').innerText(), await hero.locator('img').evaluate((i) => new URL(i.src).pathname.split('/').slice(0, 6).join('/')).catch(() => 'no image'));
  if (!(await hero.locator('img[src*="/item/bbox/"]').count())) throw new Error(`closest look is not a crop of ${PLACE.name}`);
  await hero.locator('.ow-tile[data-state="loaded"]').waitFor({ timeout: 90_000 });
  await settleImagesInView();
  log('hero caption', (await hero.locator('.ow-caption').innerText()).replace(/\s+/g, ' '));
  await shot('sheet-closest-look');
  await sheet.locator('.ow-tier-grid').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  log('tier grid', (await sheet.locator('.ow-tier-cell').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  await settleImagesInView();
  await shot('sheet-tier-grid');
  await sheet.locator('.ow-primary').click();
  await page.locator('.orbital-watch-sheet[data-view="full"]').waitFor();
  const hash = await page.evaluate(() => location.hash);
  log('full view route', hash.replace(/[\d.]+,[\d.]+/, '<point>'));
  if (!hash.startsWith('#orbital=') || !hash.endsWith('&view=full')) throw new Error(`full view route ${hash}`);
  await sheet.locator('.ow-passes').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settleImagesInView();
  log('groups', (await sheet.locator('.ow-group-toggle').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  log('status bar', await sheet.locator('.ow-statusbar').innerText());
  await shot('full-view-passes');
  const weatherTab = sheet.locator('.ow-tab[data-tab="weather"]');
  if (await weatherTab.count()) {
    await weatherTab.click();
    const credit = await sheet.locator('.ow-card').first().locator('.ow-image-credit').innerText();
    if (!/NASA GIBS|EUMETSAT/i.test(credit)) throw new Error(`weather card credit ${credit}`);
    log('weather credit', credit);
  }
  log('image credits', [...new Set(await sheet.locator('.ow-image-credit').allInnerTexts())]);
  await page.keyboard.press('Escape');
  await page.locator('.orbital-watch-sheet[data-view="sheet"]').waitFor();
  if (await page.evaluate(() => location.hash)) throw new Error('route left behind after leaving the full view');
  await close();

  failing.add('earth-search.aws.element84.com');
  await openAtPlace();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  await sheet.locator('.ow-banner-partial').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await privacy();
  log('partial banner', await sheet.locator('.ow-banner-partial').innerText());
  await settleImagesInView();
  await shot('partial-archive-failure');
  failing.clear();
  await close();

  if (fixture) {
    catalog = { ...fixture, stale: true, fetchedAt: Date.now() - 9 * 24 * HOUR };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await calibrate();
    await openAtPlace();
    await sheet.locator('.ow-headline').waitFor({ timeout: 90_000 });
    await sheet.locator('.ow-banner-stale').waitFor();
    await settleImagesInView();
    await privacy();
    log('stale banner', await sheet.locator('.ow-banner-stale').innerText());
    await shot('stale-orbit-data');
    await close();

    catalog = { ...fixture, satellites: fixture.satellites.filter((s) => s.profileId === 'himawari') };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await calibrate();
    await openAtPlace();
    await sheet.locator('.ow-empty').waitFor({ timeout: 90_000 });
    await settleImagesInView();
    await privacy();
    log('empty state', await sheet.locator('.ow-empty').innerText());
    await shot('empty-no-passes');
    await close();
  }

  const needles = pointText.match(/\d+\.\d\d/g);
  // The harness's own page loads carry the map centre in the query string; the app never navigates the page.
  const leaks = requests.filter(({ url, body, harnessNavigation }) => !harnessNavigation && !ARCHIVE_HOSTS.includes(new URL(url).hostname)
    && needles.every((n) => `${url} ${body}`.includes(n)));
  log('requests', requests.length, 'archive requests', requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname)).length);
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  const timeline = await page.evaluate((hosts) => ({
    lcp: performance.getEntriesByType('largest-contentful-paint').map((e) => e.url).filter(Boolean),
    archiveResources: performance.getEntriesByType('resource').filter((e) => hosts.includes(new URL(e.name).hostname)).length,
  }), ARCHIVE_HOSTS);
  log('lcp urls', timeline.lcp, 'archive resource entries', timeline.archiveResources);
  if (timeline.lcp.some((url) => ARCHIVE_HOSTS.includes(new URL(url).hostname))) throw new Error('archive crop became the LCP element');
  return { mobile, pointText, needles, leaks: leaks.length, lcp: timeline.lcp };
}
