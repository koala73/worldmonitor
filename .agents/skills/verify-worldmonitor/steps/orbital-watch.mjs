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

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
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
      const body = document.querySelector('.orbital-watch-sheet .ow-body')?.getBoundingClientRect();
      if (!body) return false;
      return [...document.querySelectorAll('.orbital-watch-sheet .ow-image-frame')].every((frame) => {
        const r = frame.getBoundingClientRect();
        return r.bottom < body.top || r.top > body.bottom || frame.dataset.state !== 'loading';
      });
    }, null, { timeout: 90_000 });
    const states = await sheet.locator('.ow-image-frame').evaluateAll((frames) => frames.map((f) => f.dataset.state));
    log('image states', states);
  };
  const sourceCredits = async () => {
    const sources = sheet.locator('.ow-footer .ow-sources');
    if (await sources.isHidden()) return [];
    if (!(await sources.evaluate((d) => d.open))) await sources.locator('summary').click();
    return sources.locator('.ow-source-credit').allInnerTexts();
  };
  const privacy = async () => {
    if (!(await sheet.locator('.ow-privacy').isVisible())) throw new Error('privacy notice missing');
  };

  const pickedAt = async (at) => {
    await open(at);
    const [lat, ns, lon, ew] = (await sheet.locator('.ow-point').innerText()).match(/([\d.]+)°([NS]), ([\d.]+)°([EW])/).slice(1);
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
    assertAtPlace(await sheet.locator('.ow-point').innerText());
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
  const pointText = await sheet.locator('.ow-point').innerText();
  log('picked point', pointText, 'target', PLACE.name);
  assertAtPlace(pointText);
  await sheet.locator('.ow-headline').filter({ hasText: /Checking archives|Computing/ }).first().waitFor();
  await privacy();
  await shot('loading-checking-archives');
  const headlineWhilePending = await sheet.locator('.ow-headline').innerText();
  if (/Confirmed images: \d/.test(headlineWhilePending)) throw new Error(`count shown while archives pending: ${headlineWhilePending}`);
  holdArchives = null;
  release();
  await sheet.locator('.ow-headline', { hasText: /Confirmed images: \d+/ }).waitFor({ timeout: 90_000 });
  await privacy();
  const tiers = await sheet.locator('.ow-tier-label').allInnerTexts();
  log('tier labels', [...new Set(tiers)]);
  log('confirmed images', await sheet.locator('.ow-row[data-tier="confirmed-image"] .ow-row-image img').evaluateAll((imgs) => imgs.map((i) => new URL(i.src).pathname.split('/').slice(0, 6).join('/'))));
  const confirmedImage = sheet.locator('.ow-row[data-tier="confirmed-image"] .ow-row-image').filter({ has: page.locator('img[src*="/item/bbox/"]') }).first();
  if (!(await confirmedImage.count())) throw new Error(`no confirmed crop of ${PLACE.name}`);
  await confirmedImage.evaluate((el) => el.closest('.ow-row').scrollIntoView({ block: 'center' }));
  await settleImagesInView();
  await shot('tiered-results');
  const collapsed = sheet.locator('.ow-group-toggle[aria-expanded="false"]');
  while (await collapsed.count()) await collapsed.first().click();
  const gibsImage = sheet.locator('.ow-group[data-group="mosaic"] .ow-row-image').first();
  await gibsImage.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settleImagesInView();
  const gibsCredit = gibsImage.locator('.ow-image-credit');
  if (!(await gibsCredit.isVisible()) || !/NASA GIBS/.test(await gibsCredit.innerText())) throw new Error('NASA GIBS credit missing beside its mosaic image');
  await shot('tiered-results-expanded-credits');
  log('image captions', [...new Set(await sheet.locator('.ow-image-credit').allInnerTexts())]);
  const credits = await sourceCredits();
  log('result credits', credits);
  if (!credits.includes('Orbit elements from CelesTrak')) throw new Error(`credit line misses CelesTrak: ${credits.join(' | ')}`);
  if (!credits.some((c) => c.startsWith('Contains modified Copernicus Sentinel data'))) throw new Error(`credit line misses Copernicus beside a confirmed crop: ${credits.join(' | ')}`);
  const openGroups = sheet.locator('.ow-group-toggle[aria-expanded="true"]');
  while (await openGroups.count() > 1) await openGroups.last().click();
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: mobile ? 1800 : 1600 });
  const sentinel2 = sheet.locator('.ow-row[data-tier="confirmed-image"]', { hasText: /SENTINEL-2/ }).filter({ has: page.locator('img[src*="/item/bbox/"]') }).last();
  await sentinel2.evaluate((row) => row.scrollIntoView({ block: 'start' }));
  await settleImagesInView();
  await shot('confirmed-image-and-result-credit-line');
  await page.setViewportSize(viewport);
  await close();

  failing.add('earth-search.aws.element84.com');
  await openAtPlace();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  await privacy();
  log('partial banner', await sheet.locator('.ow-banner-partial').innerText());
  await settleImagesInView();
  await shot('partial-archive-failure');
  await close();

  failing.add('planetarycomputer.microsoft.com');
  await openAtPlace();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  const withoutScenes = await sourceCredits();
  log('credits with both scene archives down', withoutScenes);
  if (withoutScenes.some((c) => /Copernicus|Landsat/.test(c))) throw new Error(`credit for an absent source: ${withoutScenes.join(' | ')}`);
  if (!withoutScenes.includes('Orbit elements from CelesTrak')) throw new Error(`credit line misses CelesTrak: ${withoutScenes.join(' | ')}`);
  await sheet.locator('.ow-sources').scrollIntoViewIfNeeded();
  await shot('credits-without-scene-archives');
  failing.clear();
  await close();

  if (fixture) {
    catalog = { ...fixture, stale: true, fetchedAt: Date.now() - 9 * 24 * HOUR };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await calibrate();
    await openAtPlace();
    await sheet.locator('.ow-banner-stale').waitFor({ timeout: 90_000 });
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
    await privacy();
    log('empty state', await sheet.locator('.ow-empty').innerText());
    log('empty state credits', await sourceCredits());
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
