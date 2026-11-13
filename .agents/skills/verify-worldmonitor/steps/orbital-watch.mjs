/**
 * Satellite passes here: right-click the globe, read the lookup sheet in each
 * state, and prove the picked point reaches only the public archives.
 *
 * WM_VERIFY_ORBITAL_CATALOG=live skips the catalog fixture and uses the local
 * API. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_AT=lat,lon centres the map on the point to pick, Palm
 * Jumeirah by default so crops can be checked against the real place.
 */
import { readFileSync } from 'node:fs';
import { matchSensorProfile } from '../../../../shared/orbital/sensor-profiles.js';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';
const HOUR = 3_600_000;

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
  page.on('request', (req) => requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  const [atLat, atLon] = (process.env.WM_VERIFY_ORBITAL_AT ?? '25.112,55.139').split(',');
  await page.goto(`${base}/dashboard?lat=${atLat}&lon=${atLon}&zoom=6`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const sheet = page.locator('.orbital-watch-sheet');
  const aim = { dx: 0, dy: 0 };
  const open = async (dx = aim.dx, dy = aim.dy) => {
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
  const privacy = async () => {
    if (!(await sheet.locator('.ow-privacy').isVisible())) throw new Error('privacy notice missing');
  };

  const pickedAt = async (dx, dy) => {
    await open(dx, dy);
    const [lat, ns, lon, ew] = (await sheet.locator('.ow-point').innerText()).match(/([\d.]+)°([NS]), ([\d.]+)°([EW])/).slice(1);
    await close();
    return { lat: ns === 'S' ? -lat : +lat, lon: ew === 'W' ? -lon : +lon };
  };
  for (let pass = 0; pass < 2; pass++) {
    const at = await pickedAt(aim.dx, aim.dy);
    const right = await pickedAt(aim.dx + 100, aim.dy);
    const down = await pickedAt(aim.dx, aim.dy + 100);
    const [a, b, c, d] = [(right.lon - at.lon) / 100, (down.lon - at.lon) / 100, (right.lat - at.lat) / 100, (down.lat - at.lat) / 100];
    const [eLon, eLat] = [Number(atLon) - at.lon, Number(atLat) - at.lat];
    const det = a * d - b * c;
    aim.dx += (d * eLon - b * eLat) / det;
    aim.dy += (a * eLat - c * eLon) / det;
  }

  let release;
  holdArchives = new Promise((resolve) => { release = resolve; });
  await open();
  const pointText = await sheet.locator('.ow-point').innerText();
  log('picked point', pointText);
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
  await shot('tiered-results');
  const collapsed = sheet.locator('.ow-group-toggle[aria-expanded="false"]');
  while (await collapsed.count()) await collapsed.first().click();
  await sheet.locator('.ow-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await shot('tiered-results-expanded-credits');
  log('image captions', [...new Set(await sheet.locator('.ow-row-image figcaption').allInnerTexts())]);
  const credits = await sheet.locator('.ow-credits li').allInnerTexts();
  log('result credits', credits);
  if (!credits.includes('Orbit elements from CelesTrak')) throw new Error(`credit line misses CelesTrak: ${credits.join(' | ')}`);
  const openGroups = sheet.locator('.ow-group-toggle[aria-expanded="true"]');
  while (await openGroups.count() > 1) await openGroups.last().click();
  const viewport = page.viewportSize();
  if (!mobile) await page.setViewportSize({ width: 1920, height: 1080 });
  await sheet.locator('.ow-credits').scrollIntoViewIfNeeded();
  await shot('confirmed-image-and-result-credit-line');
  await page.setViewportSize(viewport);
  await close();

  failing.add('earth-search.aws.element84.com');
  await open();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  await privacy();
  log('partial banner', await sheet.locator('.ow-banner-partial').innerText());
  await shot('partial-archive-failure');
  await close();

  failing.add('planetarycomputer.microsoft.com');
  await open();
  await sheet.locator('.ow-banner-partial').waitFor({ timeout: 90_000 });
  const withoutScenes = await sheet.locator('.ow-credits li').allInnerTexts();
  log('credits with both scene archives down', withoutScenes);
  if (withoutScenes.some((c) => /Copernicus|Landsat/.test(c))) throw new Error(`credit for an absent source: ${withoutScenes.join(' | ')}`);
  if (!withoutScenes.includes('Orbit elements from CelesTrak')) throw new Error(`credit line misses CelesTrak: ${withoutScenes.join(' | ')}`);
  await sheet.locator('.ow-credits').scrollIntoViewIfNeeded();
  await shot('credits-without-scene-archives');
  failing.clear();
  await close();

  if (fixture) {
    catalog = { ...fixture, stale: true, fetchedAt: Date.now() - 9 * 24 * HOUR };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await open();
    await sheet.locator('.ow-banner-stale').waitFor({ timeout: 90_000 });
    await privacy();
    log('stale banner', await sheet.locator('.ow-banner-stale').innerText());
    await shot('stale-orbit-data');
    await close();

    catalog = { ...fixture, satellites: fixture.satellites.filter((s) => s.profileId === 'himawari') };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page, { data: true });
    await waitForMap(page);
    await open();
    await sheet.locator('.ow-empty').waitFor({ timeout: 90_000 });
    await privacy();
    log('empty state', await sheet.locator('.ow-empty').innerText());
    log('empty state credits', await sheet.locator('.ow-credits li').allInnerTexts());
    await shot('empty-no-passes');
    await close();
  }

  const needles = pointText.match(/\d+\.\d\d/g);
  const leaks = requests.filter(({ url, body }) => !ARCHIVE_HOSTS.includes(new URL(url).hostname)
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
