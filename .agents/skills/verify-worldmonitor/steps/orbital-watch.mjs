/**
 * Satellite passes here: right-click the globe, read the lookup sheet in each
 * state, and prove the picked point reaches only the public archives.
 *
 * WM_VERIFY_ORBITAL_CATALOG=live skips the catalog fixture and uses the local
 * API. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * The drive uses the flat map, whose coastlines and labels show where the
 * reticle sits: deck.gl on desktop, the SVG map on a phone. The SVG map has
 * no context menu, so there every lookup opens through its route.
 * WM_VERIFY_ORBITAL_MAP=globe drives the 3D globe instead.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { matchSensorProfile } from '../../../../shared/orbital/sensor-profiles.js';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';
const HOUR = 3_600_000;
const PLACE = { name: 'Palm Jumeirah, Dubai', lat: 25.112, lon: 55.139, zoom: 9 };
// Open ocean, so the calibrating right-click at the map centre opens no country.
const START = { lat: -15, lon: 80, zoom: 4 };

function fixtureCatalog() {
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


const VENDOR_URL = /sentry|umami|\/_vercel\/insights|debugbear|dbbrum/i;

/** Where the page URL puts the map centre and the orbital route, with each one's distance from the picked point in degrees. */
function pageUrlPlaces(href) {
  const url = new URL(href);
  const off = (lat, lon) => Math.max(Math.abs(lat - PLACE.lat), Math.abs(lon - PLACE.lon));
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const route = /orbital=([-\d.]+),([-\d.]+)/.exec(url.hash);
  return {
    centre: url.searchParams.has('lat') ? { lat, lon, off: off(lat, lon) } : null,
    route: route ? { off: off(Number(route[1]), Number(route[2])) } : null,
  };
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

  // DebugBear (and Sentry's history breadcrumbs) record each same-document navigation's URL, so record what they would see.
  await page.addInitScript(() => {
    window.__wmNavigations = [];
    window.navigation?.addEventListener('navigate', (event) => window.__wmNavigations.push(event.destination.url));
  });

  const mapMode = process.env.WM_VERIFY_ORBITAL_MAP === 'globe' ? 'globe' : 'flat';
  if (mapMode === 'flat') {
    // MapContainer refuses deck.gl on a software GL renderer, and this VM only has SwiftShader.
    await page.addInitScript(() => {
      const UNMASKED_RENDERER = 0x9246;
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === UNMASKED_RENDERER ? 'verify renderer' : original.call(this, parameter);
      };
    });
  }
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': JSON.stringify(mapMode) } });
  // WM_VERIFY_ORBITAL_LAYERS=conflicts boots with a dashboard layer over the point, to prove the full view hides it.
  const bootLayers = process.env.WM_VERIFY_ORBITAL_LAYERS || 'none';
  // Boot far from the point, so a centre in the page URL near it could only have come from the lookup.
  await page.goto(`${base}/dashboard?view=global&layers=${bootLayers}&lat=${START.lat}&lon=${START.lon}&zoom=${START.zoom}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  await page.waitForTimeout(600);
  const bootCentre = pageUrlPlaces(await page.evaluate(() => location.href)).centre;
  log('page url centre at boot', JSON.stringify(bootCentre));

  const sheet = page.locator('.orbital-watch-sheet');
  const sources = sheet.locator('.ow-body .ow-sources');
  const sourceCredits = async (keepOpen = false) => {
    if (await sources.isHidden()) return [];
    if (!(await sources.evaluate((d) => d.open))) await sources.locator('summary').click();
    const credits = await sources.locator('li').allInnerTexts();
    if (!keepOpen) await sources.locator('summary').click();
    return credits;
  };
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
  // A banner pushes the hero down; both it and the hero's caption and credit must show above the privacy line.
  const showHeroCredit = async () => {
    const clipped = await page.evaluate(() => {
      const credit = document.querySelector('.orbital-watch-sheet .ow-card .ow-image-credit');
      if (!credit) return 'no hero credit';
      const floor = () => Math.min(...[...document.querySelectorAll('.orbital-watch-sheet .ow-privacy, .mobile-tab-bar')]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top), window.innerHeight);
      const over = credit.getBoundingClientRect().bottom + 4 - floor();
      if (over > 0) document.querySelector('.orbital-watch-sheet .ow-body')?.scrollBy(0, over);
      if (credit.getBoundingClientRect().bottom > floor()) return 'hero credit under the privacy line';
      const banner = document.querySelector('.orbital-watch-sheet .ow-banner')?.getBoundingClientRect();
      const top = document.querySelector('.orbital-watch-sheet .ow-body')?.getBoundingClientRect().top ?? 0;
      return banner && banner.top < top - 1 ? 'banner scrolled out of the sheet' : null;
    });
    if (clipped) throw new Error(clipped);
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
    const before = await page.evaluate(() => location.hash);
    await open(at);
    // A lookup opened from the map writes no route; only the full view (a shareable link) does.
    const opened = await page.evaluate(() => location.hash);
    log('page url hash (sheet opened from the map)', opened || 'none');
    if (opened !== before && /orbital=/.test(opened)) throw new Error(`a lookup opened from the map wrote its point into the hash: ${opened}`);
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
    if (renderer === 'svg') return;
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
  const heroCredit = await hero.locator('.ow-image-credit').innerText();
  log('hero credit', heroCredit);
  if (!/COPERNICUS SENTINEL|LANDSAT/i.test(heroCredit)) throw new Error(`closest look has no image credit: ${heroCredit}`);
  if (await sheet.locator('.orbital-watch-sheet, .ow-panel').first().evaluate((el) => el.textContent.includes('We acknowledge'))) throw new Error('acknowledgement paragraph in the sheet');
  // At rest the hero, its caption, REPLAY and credit all sit above the privacy line.
  const checkHeroFits = async (view) => {
    const heroFits = await page.evaluate(() => {
      const card = document.querySelector('.orbital-watch-sheet .ow-card');
      const floor = Math.min(...[...document.querySelectorAll('.orbital-watch-sheet .ow-privacy, .mobile-tab-bar')]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top), window.innerHeight);
      const r = card.getBoundingClientRect();
      const tile = card.querySelector('.ow-tile').getBoundingClientRect();
      const replay = card.querySelector('.ow-replay')?.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), image: Math.round(tile.height), replay: replay ? Math.round(replay.bottom) : null, floor: Math.round(floor) };
    });
    log(`${view} hero box`, JSON.stringify(heroFits));
    if (heroFits.bottom > heroFits.floor) throw new Error(`${view}: hero and caption run under the bottom edge: ${JSON.stringify(heroFits)}`);
  };
  await checkHeroFits('sheet');
  log('sheet map mark', JSON.stringify(await markAt()));
  await hero.locator('.ow-image-credit').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await shot('sheet-closest-look');
  // A lookup centres the map on the point; the map's URL sync (debounced 250 ms) must keep the pre-lookup centre.
  const checkPageUrl = async (stage, { route = false } = {}) => {
    await page.waitForTimeout(600);
    const { centre, route: inRoute } = pageUrlPlaces(await page.evaluate(() => location.href));
    log(`page url (${stage})`, 'centre', JSON.stringify(centre), 'orbital route', inRoute ? `${inRoute.off.toFixed(4)}° from the point` : 'none');
    if (centre && centre.off < 1) throw new Error(`page URL centre is ${centre.off.toFixed(4)}° from the picked point (${stage})`);
    if (JSON.stringify(centre) !== JSON.stringify(bootCentre)) throw new Error(`page URL centre moved during the lookup (${stage})`);
    if (inRoute && !route) throw new Error(`orbital route left in the page URL (${stage})`);
  };
  await checkPageUrl('sheet', { route: true });
  const credits = await sourceCredits(true);
  log('sources', credits);
  if (!credits.includes('CelesTrak · orbit elements')) throw new Error(`sources miss CelesTrak: ${credits.join(' | ')}`);
  if (!credits.some((c) => c.startsWith('Copernicus Sentinel · contains modified Copernicus Sentinel data'))) throw new Error(`sources miss Copernicus beside a confirmed crop: ${credits.join(' | ')}`);
  if (credits.some((c) => { const [name, supplied] = c.split(' · '); return supplied?.toLowerCase().startsWith(name.toLowerCase()); })) throw new Error(`a source entry repeats its name: ${credits.join(' | ')}`);
  await sources.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await shot('sheet-sources-open');
  await sources.locator('summary').click();
  await sheet.locator('.ow-tier-grid').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  log('tier grid', (await sheet.locator('.ow-tier-cell').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  await settleImagesInView();
  await shot('sheet-tier-grid');
  // The full view hides the dashboard's data layers; the share URL and the saved toggles keep them.
  const layerState = () => page.evaluate(() => ({
    url: new URL(location.href).searchParams.get('layers'),
    saved: localStorage.getItem('worldmonitor-layers'),
    svgZones: document.querySelectorAll('#mapContainer .conflict-zone').length,
  }));
  const layersBefore = await layerState();
  if (bootLayers !== 'none') await shot('layers-in-sheet');
  await sheet.locator('.ow-primary').click();
  await page.locator('.orbital-watch-sheet[data-view="full"]').waitFor();
  await page.waitForTimeout(800);
  const layersFull = await layerState();
  log('layers (sheet → full view)', JSON.stringify({ ...layersBefore, saved: !!layersBefore.saved }), '→', JSON.stringify({ ...layersFull, saved: !!layersFull.saved }));
  if (layersFull.url !== layersBefore.url || layersFull.saved !== layersBefore.saved) throw new Error('the full view changed the layer state the dashboard shares or saves');
  if (layersFull.svgZones) throw new Error(`${layersFull.svgZones} conflict zones still drawn over the full view`);
  if (bootLayers !== 'none') await shot('layers-hidden-in-full-view');
  const hash = await page.evaluate(() => location.hash);
  log('full view route', hash.replace(/[\d.]+,[\d.]+/, '<point>'));
  if (!hash.startsWith('#orbital=') || !hash.endsWith('&view=full')) throw new Error(`full view route ${hash}`);
  await checkPageUrl('full view', { route: true });
  await sheet.locator('.ow-body').evaluate((el) => el.scrollTo(0, 0));
  await settleImagesInView();
  await checkHeroFits('full view');
  if (mobile) await shot('full-view-closest-look');
  await sheet.locator('.ow-passes').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settleImagesInView();
  log('groups', (await sheet.locator('.ow-group-toggle').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')));
  log('status bar', await sheet.locator('.ow-statusbar').innerText());
  log('full view map mark', JSON.stringify(await markAt()));
  if (!mobile) {
    log('map mark', await sheet.locator('.ow-mapmark-label').innerText());
    if (!(await sheet.locator('.ow-mapmark-ring').isVisible())) throw new Error('point not marked on the map');
    const chrome = await page.evaluate(() => {
      // The full view lets pointer input through to the map around its panels, so the map is the only other thing allowed here.
      const owners = [document.querySelector('.orbital-watch-sheet'), document.getElementById('mapContainer')];
      const hits = [[1440 - 30, 8], [1440 - 120, 8], [1440 - 220, 8], [80, 8], [300, 300]].map(([x, y]) => document.elementFromPoint(x, y));
      return hits.filter((el) => el && !owners.some((owner) => owner?.contains(el))).map((el) => el.className || el.tagName);
    });
    if (chrome.length) throw new Error(`app chrome shows through the full view: ${chrome.join(', ')}`);
    const mapTakesInput = await page.evaluate(() => !!document.getElementById('mapContainer')?.contains(document.elementFromPoint(300, 300)));
    if (!mapTakesInput) throw new Error('the full view blocks pointer input to the map around its panels');
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
  await page.waitForTimeout(800);
  const layersBack = await layerState();
  log('layers (back to the sheet)', JSON.stringify({ ...layersBack, saved: !!layersBack.saved }));
  if (JSON.stringify(layersBack) !== JSON.stringify(layersBefore)) throw new Error('leaving the full view did not restore the dashboard layers exactly');
  if (bootLayers !== 'none') await shot('layers-back-in-sheet');
  await close();
  await checkPageUrl('after close');
  // Closing puts the map back where it was, so a click or a zoom that hands the URL centre back cannot publish the point.
  const mapBox = await page.locator('#mapContainer').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(1_500);
  const centreAfterGestures = pageUrlPlaces(await page.evaluate(() => location.href)).centre;
  log('page url centre after a click and a zoom', JSON.stringify(centreAfterGestures));
  if (centreAfterGestures && centreAfterGestures.off < 0.5) throw new Error('a click or zoom after closing published the picked point as the map centre');

  failing.add('earth-search.aws.element84.com');
  await openAtPlace();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  await sheet.locator('.ow-banner-partial').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await privacy();
  log('partial banner', await sheet.locator('.ow-banner-partial').innerText());
  await showHeroCredit();
  await settleImagesInView();
  await shot('partial-archive-failure');
  await close();

  failing.add('planetarycomputer.microsoft.com');
  await openAtPlace();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  await settleImagesInView();
  const shownCard = async () => sheet.locator('.ow-track .ow-card').nth(Number((await sheet.locator('.ow-pager-count').innerText()).split('/')[0]) - 1);
  for (let step = 0; step < 8; step++) {
    if ((await (await shownCard()).locator('.ow-tile').getAttribute('data-state')) === 'loaded') break;
    const next = sheet.locator('.ow-pager-btn[data-action="next"]');
    if (await next.isDisabled()) break;
    await next.click();
    await settleImagesInView();
  }
  const weatherHero = await shownCard();
  const weatherCaption = (await weatherHero.locator('.ow-caption-lines').innerText()).replace(/\s+/g, ' ');
  const weatherCredit = await weatherHero.locator('.ow-image-credit').innerText();
  log('weather hero caption', weatherCaption, '|', weatherCredit);
  if (!/\d/.test(weatherCaption) || !/DAILY MOSAIC|GEOSTATIONARY/i.test(weatherCaption) || !/NASA GIBS|EUMETSAT/i.test(weatherCredit)) throw new Error(`weather hero caption incomplete: ${weatherCaption} | ${weatherCredit}`);
  await weatherHero.locator('.ow-image-credit').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await privacy();
  await shot('weather-hero-without-scene-archives');
  const withoutScenes = await sourceCredits(true);
  log('sources with both scene archives down', withoutScenes);
  if (withoutScenes.some((c) => /Copernicus|Landsat/.test(c))) throw new Error(`credit for an absent source: ${withoutScenes.join(' | ')}`);
  if (!withoutScenes.includes('CelesTrak · orbit elements')) throw new Error(`sources miss CelesTrak: ${withoutScenes.join(' | ')}`);
  await sources.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await shot('sources-without-scene-archives');
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
    await showHeroCredit();
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
    const emptyCredits = await sourceCredits();
    log('empty state sources', emptyCredits);
    if (emptyCredits.some((c) => c.startsWith('CelesTrak'))) throw new Error('CelesTrak credited with no passes listed');
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
  // RUM resource timings keep a URL's path, so the point may ride only in an archive request's query or body.
  const pathLeaks = requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname)
    && needles.some((n) => new URL(url).pathname.includes(n)));
  log('archive requests with the point in the path', pathLeaks.length);
  if (pathLeaks.length) throw new Error(`picked point in an archive URL path: ${pathLeaks.map((l) => l.url).join(', ')}`);
  const timeline = await page.evaluate((hosts) => ({
    lcp: performance.getEntriesByType('largest-contentful-paint').map((e) => e.url).filter(Boolean),
    archiveResources: performance.getEntriesByType('resource').filter((e) => hosts.includes(new URL(e.name).hostname)).length,
  }), ARCHIVE_HOSTS);
  log('lcp urls', timeline.lcp, 'archive resource entries', timeline.archiveResources);
  const vendor = requests.filter(({ url }) => VENDOR_URL.test(url));
  const vendorLeaks = vendor.filter(({ url, body }) => needles.every((n) => decodeURIComponent(`${url} ${body}`).includes(n)));
  log('telemetry vendor requests', vendor.length, 'at', [...new Set(vendor.map(({ url }) => { const u = new URL(url); return u.host + u.pathname; }))], 'carrying the point', vendorLeaks.length);
  if (vendorLeaks.length) throw new Error(`picked point in a telemetry payload: ${vendorLeaks.map((l) => l.url).join(', ')}`);
  const navigations = (await page.evaluate(() => window.__wmNavigations)).map(pageUrlPlaces);
  const centresNearPoint = navigations.filter(({ centre }) => centre && centre.off < 0.01).length;
  log('same-document navigations', navigations.length, 'with a map centre within 0.01° of the point', centresNearPoint,
    'with the orbital route', navigations.filter(({ route }) => route).length);
  if (centresNearPoint) throw new Error('a same-document navigation put the picked point in the page query');
  if (timeline.lcp.some((url) => ARCHIVE_HOSTS.includes(new URL(url).hostname))) throw new Error('archive crop became the LCP element');

  // A shared link opens with no click on the globe, so nothing else stops its idle spin carrying the point away.
  // It also builds the renderer while the full view already hides the layers, so check they stay hidden.
  await page.goto(`${base}/dashboard?view=global&layers=${bootLayers}#orbital=${PLACE.lat.toFixed(4)},${PLACE.lon.toFixed(4)}&view=full`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await expectVisible('.orbital-watch-sheet');
  const landed = await markAt();
  await page.waitForTimeout(5_000);
  const later = await markAt();
  log('shared link map mark', JSON.stringify(landed), 'after 5 s', JSON.stringify(later));
  if (Math.abs(later.x - landed.x) > 4 || Math.abs(later.y - landed.y) > 4) throw new Error('the map drifted off a shared point');
  // The conflict zone over the point is the dashboard's red; count it where the full view leaves the map visible.
  const drawnLayers = async () => {
    const zones = await page.evaluate(() => document.querySelectorAll('#mapContainer .conflict-zone').length);
    const box = await page.locator('#mapContainer').boundingBox();
    const png = PNG.sync.read(await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.width, 400), height: Math.min(box.height, 300) } }));
    let red = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 150 && png.data[i + 1] < 90 && png.data[i + 2] < 90) red += 1;
    return { zones, red };
  };
  const sharedFull = await drawnLayers();
  if (bootLayers !== 'none') await shot('shared-full-view-layers');
  await page.keyboard.press('Escape');
  await page.locator('.orbital-watch-sheet[data-view="sheet"]').waitFor();
  await page.waitForTimeout(1_000);
  const sharedSheet = await drawnLayers();
  log('shared full view layers', JSON.stringify(sharedFull), '→ sheet', JSON.stringify(sharedSheet));
  if (sharedFull.zones) throw new Error(`${sharedFull.zones} conflict zones drawn over a shared full view`);
  if (bootLayers !== 'none' && sharedFull.red >= sharedSheet.red) throw new Error('a shared full view drew the dashboard layers');
  return { mobile, pointText, needles, leaks: leaks.length, lcp: timeline.lcp };
}
