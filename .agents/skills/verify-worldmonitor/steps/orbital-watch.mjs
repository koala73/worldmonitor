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
  let emptyArchives = false;
  await page.route((url) => ARCHIVE_HOSTS.includes(url.hostname), async (route) => {
    if (holdArchives) await holdArchives;
    const url = new URL(route.request().url());
    if (failing.has(url.hostname)) return route.fulfill({ status: 503, body: 'unavailable' });
    if (emptyArchives && url.pathname.endsWith('/search')) return route.fulfill({ json: { type: 'FeatureCollection', features: [] } });
    if (emptyArchives && url.hostname === 'gibs.earthdata.nasa.gov' && url.pathname.endsWith('.xml')) {
      return route.fulfill({ contentType: 'text/xml', body: '<Domains><Domain></Domain></Domains>' });
    }
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
  // Opening a lookup flies the map so the point sits in the middle of what the sheet leaves visible, so aim at
  // client positions, not offsets from the canvas centre.
  const open = async (at = null) => {
    if (!at) {
      const box = await page.locator('#mapContainer canvas').first().boundingBox();
      at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    await page.mouse.click(at.x, at.y, { button: 'right' });
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
    const line = sheet.locator('.ow-privacy-line');
    if (!(await line.isVisible())) throw new Error('privacy line missing');
    const box = await line.boundingBox();
    if (box.height > 30) throw new Error(`privacy line is ${box.height}px tall`);
  };

  // Where the reticle sits once the map has stopped flying, and that it sits mid-way across the map the panels leave visible.
  const markAt = async () => {
    let prev = null;
    for (let tries = 0; tries < 60; tries++) {
      const now = await page.evaluate(() => {
        const mark = document.querySelector('.ow-mapmark');
        if (!mark || mark.hidden) return null;
        const ring = mark.querySelector('.ow-mapmark-ring').getBoundingClientRect();
        const m = document.getElementById('mapContainer').getBoundingClientRect();
        let area = { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
        const size = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
        for (const sel of ['.ow-panel', '.ow-dock', '.ow-statusbar']) {
          const c = document.querySelector(`.orbital-watch-sheet ${sel}`)?.getBoundingClientRect();
          if (!c || !c.width || !c.height || c.right <= area.left || c.left >= area.right || c.bottom <= area.top || c.top >= area.bottom) continue;
          area = [{ ...area, right: Math.min(area.right, c.left) }, { ...area, left: Math.max(area.left, c.right) },
            { ...area, bottom: Math.min(area.bottom, c.top) }, { ...area, top: Math.max(area.top, c.bottom) }]
            .reduce((best, side) => (size(side) > size(best) ? side : best));
        }
        return { x: Math.round(ring.left + ring.width / 2), y: Math.round(ring.top + ring.height / 2),
          cx: Math.round((area.left + area.right) / 2), cy: Math.round((area.top + area.bottom) / 2),
          left: Math.round(area.left), top: Math.round(area.top) };
      });
      if (now && prev && now.x === prev.x && now.y === prev.y) {
        if (Math.abs(now.x - now.cx) > 40 || Math.abs(now.y - now.cy) > 40) {
          throw new Error(`reticle at ${now.x},${now.y}, not centred in the visible map at ${now.cx},${now.cy}`);
        }
        return now;
      }
      prev = now;
      await page.waitForTimeout(250);
    }
    throw new Error(`reticle never settled on the map: ${JSON.stringify(prev)}`);
  };
  const pickedAt = async (at) => {
    await open(at);
    const [lat, ns, lon, ew] = (await sheet.locator('.ow-place').innerText()).match(/([\d.]+)°([NS]) ([\d.]+)°([EW])/).slice(1);
    const mark = await markAt();
    await close();
    return { lat: ns === 'N' ? +lat : -lat, lon: ew === 'E' ? +lon : -lon, mark };
  };
  const assertAtPlace = (text) => {
    const [lat, lon] = text.match(/[\d.]+/g).map(Number);
    if (Math.abs(lat - PLACE.lat) > 0.005 || Math.abs(lon - PLACE.lon) > 0.005) throw new Error(`picked ${text}, not ${PLACE.name}`);
  };
  // The context menu opens a lookup wherever the globe is pointed; the shared point itself is opened through its route,
  // the same link a shared lookup gives, so every state is shot at exactly the point.
  const openAtPlace = async () => {
    await page.evaluate(({ lat, lon }) => {
      history.replaceState(history.state, '', location.pathname + location.search);
      location.hash = `orbital=${lat.toFixed(4)},${lon.toFixed(4)}`;
    }, PLACE);
    await expectVisible('.orbital-watch-sheet');
  };
  const calibrate = async () => {
    const picked = await pickedAt(null);
    log('context menu pick', JSON.stringify(picked));
  };
  await calibrate();

  let release;
  holdArchives = new Promise((resolve) => { release = resolve; });
  await openAtPlace();
  const pointText = await sheet.locator('.ow-place').innerText();
  log('picked point', pointText, 'target', PLACE.name);
  assertAtPlace(pointText);
  await sheet.locator('.ow-step[data-status="running"]', { hasText: 'Archives' }).waitFor({ timeout: 90_000 });
  await privacy();
  if (await sheet.locator('.ow-headline').count()) throw new Error('results shown while archives pending');
  log('steps', (await sheet.locator('.ow-step').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  log('loading map mark', JSON.stringify(await markAt()));
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
  const heroFits = await page.evaluate(() => {
    const card = document.querySelector('.orbital-watch-sheet .ow-card');
    const floor = Math.min(...[...document.querySelectorAll('.orbital-watch-sheet .ow-privacy, .mobile-tab-bar')]
      .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top), window.innerHeight);
    const r = card.getBoundingClientRect();
    const tile = card.querySelector('.ow-tile').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), image: Math.round(tile.height), floor: Math.round(floor) };
  });
  log('hero box', JSON.stringify(heroFits));
  if (heroFits.bottom > heroFits.floor) throw new Error(`hero and caption run under the bottom edge: ${JSON.stringify(heroFits)}`);
  log('sheet map mark', JSON.stringify(await markAt()));
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
  log('full view map mark', JSON.stringify(await markAt()));
  if (!mobile) {
    log('map mark', await sheet.locator('.ow-mapmark-label').innerText());
    if (!(await sheet.locator('.ow-mapmark-ring').isVisible())) throw new Error('point not marked on the map');
    const chrome = await page.evaluate(() => {
      const sheetEl = document.querySelector('.orbital-watch-sheet');
      const hits = [[1440 - 30, 8], [1440 - 120, 8], [1440 - 220, 8], [80, 8]].map(([x, y]) => document.elementFromPoint(x, y));
      return hits.filter((el) => el && !sheetEl.contains(el)).map((el) => el.className || el.tagName);
    });
    if (chrome.length) throw new Error(`app chrome shows through the full view: ${chrome.join(', ')}`);
  }
  const wrapped = await sheet.locator('.ow-row-meta, .ow-row-credit').evaluateAll((els) => els.filter((el) => el.scrollHeight > 18).length);
  if (wrapped) throw new Error(`${wrapped} pass row lines wrap`);
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
    log('stale map mark', JSON.stringify(await markAt()));
  await shot('stale-orbit-data');
    await close();

    catalog = { ...fixture, satellites: fixture.satellites.filter((s) => s.profileId === 'himawari') };
    emptyArchives = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await calibrate();
    await openAtPlace();
    await sheet.locator('.ow-empty').waitFor({ timeout: 90_000 });
    await settleImagesInView();
    await privacy();
    log('empty state', await sheet.locator('.ow-empty').innerText());
    log('empty headline', await sheet.locator('.ow-headline-row').innerText());
    if (await sheet.locator('.ow-card, [data-action="retry"]').count()) throw new Error('empty state is not empty');
    if (await sheet.locator('.ow-card img, .ow-row img').count()) throw new Error('empty state shows images');
    log('empty map mark', JSON.stringify(await markAt()));
  await shot('empty-no-passes');
    emptyArchives = false;
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

  // A shared link opens with no click on the globe, so nothing else stops its idle spin carrying the point away.
  await page.goto(`${base}/dashboard?view=global#orbital=${PLACE.lat.toFixed(4)},${PLACE.lon.toFixed(4)}&view=full`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await expectVisible('.orbital-watch-sheet');
  const landed = await markAt();
  await page.waitForTimeout(5_000);
  const later = await markAt();
  log('shared link map mark', JSON.stringify(landed), 'after 5 s', JSON.stringify(later));
  if (Math.abs(later.x - landed.x) > 4 || Math.abs(later.y - landed.y) > 4) throw new Error('the map drifted off a shared point');
  return { mobile, pointText, needles, leaks: leaks.length, lcp: timeline.lcp };
}
