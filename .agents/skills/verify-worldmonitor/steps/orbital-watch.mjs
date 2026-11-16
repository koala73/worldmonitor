/**
 * Satellite passes here: right-click the map, read the imagery evidence sheet in each
 * state, and prove the picked point reaches only the public archives.
 *
 * WM_VERIFY_ORBITAL_CATALOG=live skips the catalog fixture and uses the local
 * API. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * The drive uses the flat map: deck.gl on desktop, the SVG map on a phone. The
 * SVG map has no context menu, so there every lookup opens through its route.
 * WM_VERIFY_ORBITAL_MAP=globe drives the 3D globe instead. WM_VERIFY_ORBITAL_THEME=light drives
 * the light theme.
 */
import { readFileSync } from 'node:fs';
import { matchSensorProfile } from '../../../../shared/orbital/sensor-profiles.js';
import { archiveUrlAfterScrub, pointFromText, pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

// The archives whose image URLs carry the box around the point; the page must paint those from blob: URLs.
const POINT_IMAGE_HOSTS = ['planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const PREVIEW_HOSTS = [...ARCHIVE_HOSTS, 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'sentinel-s1-l1c.s3.amazonaws.com'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';
const HOUR = 3_600_000;
// A share link keeps two decimals, so the route opens exactly this point.
const PLACE = { name: 'Palm Jumeirah, Dubai', lat: 25.11, lon: 55.14 };
// Open ocean, so the calibrating right-click at the map centre opens no country.
const START = { lat: -15, lon: 80, zoom: 4 };

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


const VENDOR_URL = /sentry|umami|\/_vercel\/insights|debugbear|dbbrum/i;
const SHEET = '.imagery-evidence-sheet';

/** Where the page URL puts the map centre and the orbital route, with each one's distance from the picked point in degrees. */
function pageUrlPlaces(href) {
  const url = new URL(href);
  const off = (lat, lon) => Math.max(Math.abs(lat - PLACE.lat), Math.abs(lon - PLACE.lon));
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const route = /orbital=([-\d.]+),([-\d.]+)/.exec(url.hash);
  return {
    centre: url.searchParams.has('lat') ? { lat, lon, off: off(lat, lon) } : null,
    route: route ? { off: off(Number(route[1]), Number(route[2])), decimals: Math.max(...route.slice(1, 3).map((n) => n.split('.')[1]?.length ?? 0)) } : null,
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

  // Every LCP URL and every <img> src, kept across page loads.
  const lcpUrls = [];
  const imgSrcs = [];
  await page.exposeFunction('__wmRecordLcp', (url) => { lcpUrls.push(url); });
  await page.exposeFunction('__wmRecordSrc', (src) => { imgSrcs.push(src); });
  // DebugBear (and Sentry's history breadcrumbs) record each same-document navigation's URL, so record what they would see.
  await page.addInitScript(() => {
    window.__wmNavigations = [];
    window.navigation?.addEventListener('navigate', (event) => window.__wmNavigations.push(event.destination.url));
    // DebugBear reports the largest paint's URL; `getEntriesByType` returns no LCP entries, so observe them.
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__wmRecordLcp(entry.url); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    // Every src a sheet or viewer <img> is ever given, so a point-bearing URL painted for a moment is still caught.
    new MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes].flatMap((n) => (n.nodeType === 1 ? [n, ...n.querySelectorAll('img')] : []));
        for (const node of nodes) if (node.tagName === 'IMG' && node.getAttribute('src') && node.closest('.imagery-evidence-sheet, .oiv-dialog')) window.__wmRecordSrc(node.getAttribute('src'));
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  });
  // Every LCP URL must be a blob: or carry no archive host, so the RUM beacon never names the point's box.
  const checkLcp = (stage) => {
    const urls = lcpUrls.filter(Boolean);
    log(`${stage} lcp urls`, urls.map((url) => (url.startsWith('blob:') ? 'blob:…' : url)));
    const leaking = urls.filter((url) => !url.startsWith('blob:') && ARCHIVE_HOSTS.includes(new URL(url).hostname));
    if (leaking.length) throw new Error(`${stage}: an archive URL became the LCP element: ${leaking.join(', ')}`);
  };

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
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': JSON.stringify(mapMode), 'worldmonitor-theme': theme } });
  // WM_VERIFY_ORBITAL_LAYERS=conflicts boots with a dashboard layer over the point.
  const bootLayers = process.env.WM_VERIFY_ORBITAL_LAYERS || 'none';
  // Boot far from the point, so a centre in the page URL near it could only have come from the lookup.
  await page.goto(`${base}/dashboard?view=global&layers=${bootLayers}&lat=${START.lat}&lon=${START.lon}&zoom=${START.zoom}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  await page.waitForTimeout(600);
  const bootCentre = pageUrlPlaces(await page.evaluate(() => location.href)).centre;
  log('page url centre at boot', JSON.stringify(bootCentre));

  const sheet = page.locator(SHEET);
  const sources = sheet.locator('.ies-sources');
  const sourceCredits = async () => {
    if (await sources.isHidden()) return [];
    if (!(await sources.evaluate((d) => d.open))) await sources.locator('summary').click();
    return sources.locator('li').allInnerTexts();
  };
  const closeSources = async () => {
    if (await sources.isVisible() && await sources.evaluate((d) => d.open)) await sources.locator('summary').click();
  };
  const sheetPoint = async () => pointFromText(`${await sheet.locator('.ies-place').innerText()} ${await sheet.locator('.ies-coords').innerText()}`);
  const open = async () => {
    const box = await page.locator('#mapContainer canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Satellite passes here' }).or(page.getByText('Satellite passes here', { exact: true })).first().click();
    await expectVisible(SHEET);
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'mapContainer') throw new Error(`focus after close went to ${focused}`);
  };
  // One visible privacy line in every state, inside the viewport and kept to a single line.
  const privacy = async () => {
    const line = sheet.locator('.ies-privacy-line');
    if (!(await line.isVisible())) throw new Error('privacy line missing');
    const text = await line.innerText();
    if (!/only to the image archives/.test(text)) throw new Error(`privacy line reads ${text}`);
    const box = await line.boundingBox();
    if (box.height > 30 || box.y + box.height > (mobile ? 844 : 900)) throw new Error(`privacy line is clipped or wraps: ${JSON.stringify(box)}`);
  };
  // Where the map drew the target: the centroid of its accent-green pixels, clear of anything painted over the map.
  const drawnTargetAt = async () => {
    const map = await page.locator('#mapContainer').boundingBox();
    const png = (await page.screenshot({ clip: map })).toString('base64');
    return page.evaluate(async ({ png, renderer }) => {
      const map = document.getElementById('mapContainer').getBoundingClientRect();
      // Page elements that paint over the map (the sheet, controls, the time range) are left out; an SVG map is the drawing.
      const paints = (el) => {
        const css = getComputedStyle(el);
        if (el.closest('svg') || css.visibility !== 'visible' || css.opacity === '0') return false;
        return el.tagName === 'IMG' || css.backgroundImage !== 'none' || !/^(transparent|rgba\(.*, 0\))$/.test(css.backgroundColor);
      };
      const holes = [...document.body.querySelectorAll('*')].filter((el) => el.tagName !== 'CANVAS' && !el.querySelector('canvas') && paints(el))
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.right > map.left && r.left < map.right && r.bottom > map.top && r.top < map.bottom);
      const green = getComputedStyle(document.documentElement).getPropertyValue('--green').trim().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = width / map.width;
      let n = 0, sx = 0, sy = 0;
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 4;
        if (Math.abs(data[i] - r) > 12 || Math.abs(data[i + 1] - g) > 12 || Math.abs(data[i + 2] - b) > 12) continue;
        const x = map.left + px / scale, y = map.top + py / scale;
        if (holes.some((h) => x >= h.left && x <= h.right && y >= h.top && y <= h.bottom)) continue;
        n++; sx += x; sy += y;
      }
      return n >= 20 ? { x: Math.round(sx / n), y: Math.round(sy / n), onMap: true, underSheet: false, drawnBy: renderer, pixels: n } : null;
    }, { png, renderer });
  };
  // Where the reticle sits once the map has stopped flying; it must sit on the map, clear of the sheet.
  // A map that draws the target itself hides the sheet's DOM reticle, so the target is found in the map's drawing.
  const markAt = async () => {
    const drawn = await page.locator('.ies-mapmark').isHidden();
    let prev = null;
    for (let tries = 0; tries < 60; tries++) {
      const now = drawn ? await drawnTargetAt() : await page.evaluate(() => {
        const mark = document.querySelector('.ies-mapmark');
        if (!mark || mark.hidden) return null;
        const ring = mark.querySelector('.ies-mapmark-ring').getBoundingClientRect();
        const panel = document.querySelector('.imagery-evidence-sheet .ies-panel').getBoundingClientRect();
        const map = document.getElementById('mapContainer').getBoundingClientRect();
        const x = Math.round(ring.left + ring.width / 2);
        const y = Math.round(ring.top + ring.height / 2);
        return { x, y, onMap: x >= map.left && x <= map.right && y >= map.top && y <= map.bottom,
          underSheet: x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom };
      });
      if (now && prev && Math.abs(now.x - prev.x) <= 1 && Math.abs(now.y - prev.y) <= 1) {
        if (!now.onMap || now.underSheet) throw new Error(`reticle is off the visible map: ${JSON.stringify(now)}`);
        return now;
      }
      prev = now;
      await page.waitForTimeout(250);
    }
    throw new Error(`reticle never settled on the map: ${JSON.stringify(prev)}`);
  };
  // The context menu opens a lookup wherever the map is pointed; the place itself is opened through its two-decimal route,
  // the same link a shared lookup gives, so every state is shot at exactly the point.
  const openAtPlace = async () => {
    await page.evaluate(({ lat, lon }) => {
      history.replaceState(history.state, '', location.pathname + location.search);
      location.hash = `orbital=${lat.toFixed(2)},${lon.toFixed(2)}`;
    }, PLACE);
    await expectVisible(SHEET);
  };
  const answered = () => page.locator(`${SHEET}[data-state="answered"]`).waitFor({ timeout: 120_000 });
  const calibrate = async () => {
    if (renderer === 'svg') return;
    const before = await page.evaluate(() => location.hash);
    await open();
    const opened = await page.evaluate(() => location.hash);
    log('page url hash (sheet opened from the map)', opened || 'none');
    if (opened !== before && /orbital=/.test(opened)) throw new Error(`a lookup opened from the map wrote its point into the hash: ${opened}`);
    log('context menu pick', JSON.stringify(await sheetPoint()), 'mark', JSON.stringify(await markAt()));
    await close();
  };
  await calibrate();

  // Checking: passes are listed with their pending tier while the archives are held.
  let release;
  holdArchives = new Promise((resolve) => { release = resolve; });
  await openAtPlace();
  await page.locator(`${SHEET}[data-state="checking"]`).waitFor({ timeout: 90_000 });
  await sheet.locator('.ies-row').first().waitFor({ state: 'attached', timeout: 60_000 });
  // Only a past pass the orbit says was likely imaged waits on its archive; the rest keep their computed tier.
  log('rows while checking', await sheet.locator('.ies-row').count(), 'awaiting their archive', await sheet.locator('.ies-row[data-tier="pending"]').count());
  const picked = await sheetPoint();
  log('picked point', JSON.stringify(picked), 'target', PLACE.name);
  if (Math.abs(picked.lat - PLACE.lat) > 0.005 || Math.abs(picked.lon - PLACE.lon) > 0.005) throw new Error(`picked ${JSON.stringify(picked)}, not ${PLACE.name}`);
  const checkingLine = await sheet.locator('.ies-evidence-line').innerText();
  log('checking line', checkingLine);
  if (!/Archives answered: \d+ of \d+/.test(checkingLine)) throw new Error(`no archive progress while checking: ${checkingLine}`);
  await privacy();
  log('checking map mark', JSON.stringify(await markAt()));
  await shot('checking-archives');
  holdArchives = null;
  release();

  // Answered: every row carries a tier, the latest image is painted from a blob:, and credits match what is shown.
  await answered();
  await privacy();
  log('evidence line', await sheet.locator('.ies-evidence-line').innerText());
  const counts = await sheet.locator('.ies-count').evaluateAll((els) => Object.fromEntries(els.map((el) => [el.dataset.tier, Number(el.querySelector('dd').textContent.replace(/\D/g, ''))])));
  log('counts', JSON.stringify(counts));
  const rows = await sheet.locator('.ies-row').evaluateAll((els) => els.map((el) => ({ tier: el.dataset.tier, label: el.querySelector('.ies-tier')?.textContent ?? null })));
  const tiers = rows.reduce((acc, { tier }) => ({ ...acc, [tier]: (acc[tier] ?? 0) + 1 }), {});
  log('rows', rows.length, 'by tier', JSON.stringify(tiers));
  if (!rows.length) throw new Error('no pass rows');
  if (rows.some(({ tier }) => !tier || tier === 'pending')) throw new Error(`a row has no tier once the archives answered: ${JSON.stringify(tiers)}`);
  if (rows.some(({ tier, label }) => label !== null && !label.trim())) throw new Error('a tier label is empty');
  const latest = sheet.locator('[data-section="latest"]');
  const heroImg = latest.locator('.ow-tile-hero[data-state="loaded"] img[src^="blob:"]');
  await heroImg.waitFor({ timeout: 90_000 });
  const caption = await latest.locator('.ies-caption .ies-cell').evaluateAll((els) => els.map((el) => `${el.dataset.label}: ${el.textContent}`));
  log('latest image caption', JSON.stringify(caption));
  const heroCredit = caption.find((c) => c.startsWith('Archive')) ?? '';
  if (!/Copernicus|Landsat|USGS/i.test(heroCredit)) throw new Error(`latest image has no scene credit: ${heroCredit}`);
  const crops = requests.filter(({ url }) => POINT_IMAGE_HOSTS.includes(new URL(url).hostname) && /\/(item|bbox)\//.test(new URL(url).pathname));
  log('point crop requests', crops.length);
  if (counts.confirmed > 0 && !crops.length) throw new Error(`confirmed images but no crop of ${PLACE.name}`);
  await latest.scrollIntoViewIfNeeded();
  await shot('answered-latest-image');
  // A lookup centres the map on the point; the map's URL sync (debounced 250 ms) must keep the pre-lookup centre.
  const checkPageUrl = async (stage, { route = false } = {}) => {
    await page.waitForTimeout(600);
    const { centre, route: inRoute } = pageUrlPlaces(await page.evaluate(() => location.href));
    log(`page url (${stage})`, 'centre', JSON.stringify(centre), 'orbital route', inRoute ? `${inRoute.off.toFixed(4)}° from the point` : 'none');
    if (centre && centre.off < 1) throw new Error(`page URL centre is ${centre.off.toFixed(4)}° from the picked point (${stage})`);
    // The globe's idle spin moves its centre before the lookup holds it, so only the flat maps keep the boot centre exactly.
    if (renderer !== 'globe' && JSON.stringify(centre) !== JSON.stringify(bootCentre)) throw new Error(`page URL centre moved during the lookup (${stage})`);
    if (inRoute && !route) throw new Error(`orbital route left in the page URL (${stage})`);
    if (inRoute && inRoute.decimals > 2) throw new Error(`orbital route holds the point at ${inRoute.decimals} decimals, finer than a share link (${stage})`);
  };
  await checkPageUrl('sheet', { route: true });
  const capability = sheet.locator('[data-section="capability"]');
  await capability.scrollIntoViewIfNeeded();
  await shot('answered-tiered-passes');
  const credits = await sourceCredits();
  log('sources', credits);
  if (!credits.some((c) => c.startsWith('CelesTrak'))) throw new Error(`sources miss CelesTrak: ${credits.join(' | ')}`);
  if (/Copernicus/i.test(heroCredit) && !credits.some((c) => c.startsWith('Copernicus'))) throw new Error(`sources miss Copernicus beside a Sentinel image: ${credits.join(' | ')}`);
  await sources.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await shot('answered-sources');
  await closeSources();
  await sheet.locator('.ies-privacy-more').click();
  const privacyBody = await sheet.locator('.ies-privacy-body').innerText();
  log('privacy details', privacyBody);
  if (!/WorldMonitor does not receive it/.test(privacyBody)) throw new Error('privacy details do not say WorldMonitor never receives the point');
  await sheet.locator('.ies-privacy-more').click();
  const mapBox = await page.locator('#mapContainer').boundingBox();
  await close();
  // Closing jumps the map back where it was, so a click or a zoom straight after cannot publish the point.
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(1_500);
  const centreAfterGestures = pageUrlPlaces(await page.evaluate(() => location.href)).centre;
  log('page url centre after a click and a zoom', JSON.stringify(centreAfterGestures));
  if (centreAfterGestures && centreAfterGestures.off < 0.5) throw new Error('a click or zoom after closing published the picked point as the map centre');

  // Partial: a failed archive is named, with Retry. Archive answers are kept for the page's life, so start a fresh page.
  failing.add('earth-search.aws.element84.com');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await openAtPlace();
  await answered();
  const warn = sheet.locator('.ies-warn');
  await warn.waitFor();
  const warnText = await warn.innerText();
  log('partial note', warnText);
  if (!/Earth Search/.test(warnText) || !(await warn.locator('[data-action="retry"]').count())) throw new Error(`partial note does not name Earth Search with Retry: ${warnText}`);
  await privacy();
  await warn.scrollIntoViewIfNeeded();
  await shot('partial-archive-failure');
  failing.clear();
  await close();

  if (fixture) {
    catalog = { ...fixture, stale: true, fetchedAt: Date.now() - 9 * 24 * HOUR };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await openAtPlace();
    await sheet.locator('.ies-stale').first().waitFor({ timeout: 90_000 });
    await privacy();
    log('stale note', await sheet.locator('.ies-stale').first().innerText());
    await shot('stale-orbit-data');
    await close();

    // Himawari-9 sits over 140.7°E, below Dubai's horizon, so the catalog loads but no pass reaches the point.
    catalog = { ...fixture, satellites: fixture.satellites.filter((s) => s.profileId === 'himawari') };
    emptyArchives = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await openAtPlace();
    await answered();
    const empty = sheet.locator('.ies-empty', { hasText: 'No satellite came within reach' });
    await empty.waitFor({ timeout: 90_000 });
    await privacy();
    log('empty state', await empty.innerText(), '|', await sheet.locator('.ies-evidence-line').innerText());
    if (await sheet.locator('.ies-row, [data-action="retry"]').count()) throw new Error('empty state lists passes or offers Retry');
    if (await sheet.locator('.ies-body img').count()) throw new Error('empty state shows images');
    const emptyCredits = await sourceCredits();
    log('empty state sources', emptyCredits);
    if (emptyCredits.some((c) => c.startsWith('CelesTrak'))) throw new Error('CelesTrak credited with no passes listed');
    await closeSources();
    await shot('empty-no-passes');
    emptyArchives = false;
    await close();
  }

  const leaking = (text) => pointLeak(text, picked);
  // No request outside the archives, and no telemetry payload, may carry the point; run after every scenario's page load.
  const checkRequests = async (label) => {
    // The harness's own page loads carry the map centre in the query string; the app never navigates the page.
    const leaks = requests.filter(({ url, body, harnessNavigation }) => !harnessNavigation && !ARCHIVE_HOSTS.includes(new URL(url).hostname)
      && leaking(`${url} ${body}`));
    log(label, 'requests', requests.length, 'archive requests', requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname)).length);
    if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
    // Archives get the point, some as a crop box in the path; telemetry keeps an archive URL only after
    // its coordinate params and path segments are scrubbed, so nothing of the point may survive that.
    const pathLeaks = requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname) && leaking(archiveUrlAfterScrub(url)));
    log('archive requests with the point left after the telemetry scrub', pathLeaks.length);
    if (pathLeaks.length) throw new Error(`picked point outside an archive URL's coordinate parts: ${pathLeaks.map((l) => l.url).join(', ')}`);
    const vendor = requests.filter(({ url }) => VENDOR_URL.test(url));
    const vendorLeaks = vendor.filter(({ url, body }) => leaking(`${url} ${body}`));
    log('telemetry vendor requests', vendor.length, 'at', [...new Set(vendor.map(({ url }) => { const u = new URL(url); return u.host + u.pathname; }))], 'carrying the point', vendorLeaks.length);
    if (vendorLeaks.length) throw new Error(`picked point in a telemetry payload: ${vendorLeaks.map((l) => l.url).join(', ')}`);
    const navigations = (await page.evaluate(() => window.__wmNavigations)).map(pageUrlPlaces);
    const centresNearPoint = navigations.filter(({ centre }) => centre && centre.off < 0.01).length;
    log('same-document navigations', navigations.length, 'with a map centre within 0.01° of the point', centresNearPoint,
      'with the orbital route', navigations.filter(({ route }) => route).length);
    if (centresNearPoint) throw new Error('a same-document navigation put the picked point in the page query');
    return { leaks: leaks.length, vendorLeaks: vendorLeaks.length };
  };
  await checkRequests('lookup');
  checkLcp('lookup');
  // A sheet image is a blob: or a scene-wide archive preview; anything else is point-bearing or off the allowlist.
  const pointImgs = () => imgSrcs.filter((src) => /^https?:/.test(src) && (POINT_IMAGE_HOSTS.includes(new URL(src).hostname) || !PREVIEW_HOSTS.includes(new URL(src).hostname)));
  const lookupDirect = pointImgs();
  log('img srcs set', imgSrcs.length, 'blob:', imgSrcs.filter((src) => src.startsWith('blob:')).length, 'point-bearing or off-allowlist srcs', lookupDirect.length);
  if (lookupDirect.length) throw new Error(`point-bearing archive URL in img src: ${lookupDirect.join(', ')}`);

  // A shared link opens with no click on the map, so nothing else stops the map drifting off the point.
  catalog = fixture;
  await page.goto(`${base}/dashboard?view=global&layers=${bootLayers}#orbital=${PLACE.lat.toFixed(2)},${PLACE.lon.toFixed(2)}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await expectVisible(SHEET);
  await answered();
  // The shared sheet must paint its latest image before the image-source and LCP checks can mean anything.
  await page.waitForFunction(() => [...document.querySelectorAll('.imagery-evidence-sheet .ow-tile-hero[data-state="loaded"] img[src^="blob:"]')]
    .some((img) => img.complete && img.naturalWidth > 0), null, { timeout: 120_000 });
  const landed = await markAt();
  await page.waitForTimeout(5_000);
  const later = await markAt();
  log('shared link map mark', JSON.stringify(landed), 'after 5 s', JSON.stringify(later));
  // A shared link paints the sheet with no user input, so its images are the ones RUM can take as the LCP.
  const sharedImages = await page.evaluate(() => [...document.querySelectorAll('.imagery-evidence-sheet img[src]')].map((img) => ({
    blob: img.getAttribute('src').startsWith('blob:'), painted: img.complete && img.naturalWidth > 0,
  })));
  log('shared link images', sharedImages.length, 'blob', sharedImages.filter((i) => i.blob).length, 'painted', sharedImages.filter((i) => i.painted).length);
  if (!sharedImages.some((i) => i.blob && i.painted)) throw new Error('the shared link painted no blob: image');
  const directSrc = pointImgs();
  if (directSrc.length) throw new Error(`point-bearing archive URL in img src: ${directSrc.join(', ')}`);
  checkLcp('shared link');
  if (Math.abs(later.x - landed.x) > 4 || Math.abs(later.y - landed.y) > 4) throw new Error('the map drifted off a shared point');
  const { leaks, vendorLeaks } = await checkRequests('lookup and shared link');
  await shot('shared-link');
  return { mobile, picked, rows: rows.length, tiers, leaks, vendorLeaks, lcp: lcpUrls.filter(Boolean).length };
}
