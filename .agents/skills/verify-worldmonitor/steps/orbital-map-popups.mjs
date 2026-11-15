/**
 * Map-object imagery row (#10713 unit 1): click a military base on the map and
 * read its popup's newest image, date and next pass, then open the evidence.
 *
 * The base's seeded record is served from its real newest Planetary Computer
 * scene, so the row reads the site-id path and the crop really loads. The drive
 * fails if the read carries a point, if any non-archive request carries the
 * base's coordinates, or if the popup image is not painted from a blob: URL.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the 390px sheet on the SVG map;
 * WM_VERIFY_ORBITAL_THEME=light drives the light theme.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const BASE = { siteId: 'military-base:al_udeid', name: 'Al Udeid', lat: 25.2793, lon: 51.5224 };
const READ_PATH = '/api/orbital/v1/get-watched-site-imagery';
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const COORD = /25\.27|51\.52/;

async function newestScene() {
  const res = await fetch('https://planetarycomputer.microsoft.com/api/stac/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'], intersects: { type: 'Point', coordinates: [BASE.lon, BASE.lat] },
      limit: 1, sortby: [{ field: 'datetime', direction: 'desc' }], query: { 'eo:cloud_cover': { lt: 20 } },
    }),
  });
  const [item] = (await res.json()).features;
  return { itemId: item.id, collection: item.collection, profileId: 'sentinel-2', datetime: item.properties.datetime, cloudCoverPct: item.properties['eo:cloud_cover'] };
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const latestImage = await newestScene();
  log('newest scene', JSON.stringify(latestImage));
  const reads = [];
  await page.route(`**${READ_PATH}*`, (route) => {
    reads.push(route.request().url());
    route.fulfill({ json: {
      siteId: BASE.siteId, name: BASE.name, lat: BASE.lat, lon: BASE.lon, evaluatedAt: Date.now() - 3_600_000, stale: false,
      latestImage, nextPass: { satellite: 'SENTINEL-2C', profileId: 'sentinel-2', time: new Date(Date.now() + 9 * 3_600_000).toISOString() },
    } });
  });
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  if (!mobile) {
    await page.addInitScript(() => {
      const UNMASKED_RENDERER = 0x9246;
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === UNMASKED_RENDERER ? 'verify renderer' : original.call(this, parameter);
      };
    });
  }
  const requests = [];
  // The drive's own page load carries the map centre; every other request is checked.
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"', 'worldmonitor-theme': theme } });
  await page.goto(`${base}/dashboard?lat=${BASE.lat}&lon=${BASE.lon}&zoom=${mobile ? 6 : 8}&layers=bases`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  await page.waitForTimeout(2500);

  const popup = page.locator('.map-popup');
  if (renderer === 'svg') {
    // The SVG map draws bases as HTML markers; press the one labelled with the base.
    const marker = page.locator('.base-marker', { has: page.locator('.base-label', { hasText: new RegExp(`^${BASE.name}$`) }) });
    await marker.first().waitFor({ state: 'attached', timeout: 30_000 });
    await marker.first().evaluate((el) => el.click());
  } else {
    const box = await page.locator('#deckgl-overlay, #mapContainer canvas').first().boundingBox();
    // The base sits at the map centre; probe a few pixels around it for the icon.
    for (const [dx, dy] of [[0, 0], [0, -6], [0, 6], [-6, 0], [6, 0], [0, -12]]) {
      await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
      if (await popup.isVisible().catch(() => false)) break;
      await page.waitForTimeout(400);
    }
  }
  await expectVisible('.map-popup');
  log('popup title', await popup.locator('.popup-title').first().innerText());
  const row = popup.locator('[data-orbital-imagery]');
  await row.waitFor({ timeout: 15_000 });
  await row.locator('[data-orbital-image] img').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  const src = await row.locator('[data-orbital-image] img').getAttribute('src');
  if (!src?.startsWith('blob:')) throw new Error(`popup image painted from ${src}`);
  if (await row.locator('[data-orbital-flag], .popup-imagery-flag').count()) throw new Error('a change-flag row rendered');
  log('row text', (await row.innerText()).replace(/\s+/g, ' '));
  await row.scrollIntoViewIfNeeded();
  await shot(`popup-${mobile ? 'mobile' : 'desktop'}-${theme}`);

  if (reads.length !== 1) throw new Error(`expected one site read, saw ${reads.length}`);
  const read = new URL(reads[0]);
  if ([...read.searchParams.keys()].join() !== 'site_id' || read.searchParams.get('site_id') !== BASE.siteId) throw new Error(`site read was ${read.search}`);
  log('site read', read.pathname + read.search);

  await row.locator('[data-orbital-open-evidence]').click();
  await expectVisible('.orbital-watch-sheet');
  log('sheet place', await page.locator('.orbital-watch-sheet .ow-place').innerText().catch(() => ''));
  await page.waitForTimeout(1500);
  await shot(`evidence-${mobile ? 'mobile' : 'desktop'}-${theme}`);

  const leaks = requests.filter((r) => {
    const host = new URL(r.url).hostname;
    return !ARCHIVE_HOSTS.includes(host) && (COORD.test(new URL(r.url).pathname + new URL(r.url).search) || COORD.test(r.body));
  });
  if (leaks.length) throw new Error(`base coordinates reached a non-archive host: ${leaks.map((r) => r.url).join(', ')}`);
  const href = await page.evaluate(() => location.href);
  log('page url after popup and evidence', href.replace(/(lat|lon)=[-\d.]+/g, '$1=…'));
  return { renderer, siteRead: read.search, leaks: leaks.length };
}
