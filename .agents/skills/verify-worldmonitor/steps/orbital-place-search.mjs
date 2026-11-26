/**
 * Satellite passes place search: open a share link, search a place by name,
 * share it, and open an older `&view=full` link, proving the point reaches no WorldMonitor host.
 * The point is Palm Jumeirah, Dubai, whose fronds make a crop easy to check by eye.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport. The flat map is deck.gl on desktop
 * and the SVG map on a phone. WM_VERIFY_THEME=light boots the dashboard in its light theme.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const PALM = { name: 'Palm Jumeirah, Dubai, United Arab Emirates', lat: 25.1124, lon: 55.139, kind: 'island' };
const SHARE_FRAGMENT = '#orbital=25.11,55.14';

const SHEET = '.imagery-evidence-sheet';

async function settled(page) {
  // The sheet's data-state leaves checking once the archives answer (or the lookup ends in another state).
  await page.waitForFunction(() => {
    const state = document.querySelector('.imagery-evidence-sheet')?.dataset.state;
    return !!state && !['checking', 'computing', 'loading'].includes(state);
  }, null, { timeout: 120_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.imagery-evidence-sheet img')].every((img) => img.complete), null, { timeout: 60_000 });
}

/**
 * Where the looked-up point is marked on the visible map: the sheet's DOM ring, or, when the map draws the
 * target itself (and hides that ring), the centroid of its accent-green pixels clear of anything painted over the map.
 */
async function markOnMap(page) {
  if (await page.locator('.ies-mapmark').isVisible()) {
    return page.evaluate(() => {
      const ring = document.querySelector('.ies-mapmark .ies-mapmark-ring').getBoundingClientRect();
      return { x: Math.round(ring.left + ring.width / 2), y: Math.round(ring.top + ring.height / 2), by: 'dom' };
    });
  }
  const clip = await page.locator('#mapContainer').boundingBox();
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (png) => {
    const map = document.getElementById('mapContainer').getBoundingClientRect();
    // Map controls painted over the map (time chips, the 2D toggle) can share the accent green; skip their boxes.
    const paints = (el) => {
      const css = getComputedStyle(el);
      if (el.closest('svg') || css.visibility !== 'visible' || css.opacity === '0') return false;
      return el.tagName === 'IMG' || css.backgroundImage !== 'none' || !/^(transparent|rgba\(.*, 0\))$/.test(css.backgroundColor);
    };
    const holes = [...document.body.querySelectorAll('*')]
      .filter((el) => el.tagName !== 'CANVAS' && !el.querySelector('canvas') && !el.querySelector('#mapContainer') && paints(el))
      .map((el) => el.getBoundingClientRect())
      .filter((h) => h.width > 0 && h.height > 0 && h.right > map.left && h.left < map.right && h.bottom > map.top && h.top < map.bottom);
    const green = getComputedStyle(document.documentElement).getPropertyValue('--green').trim().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
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
    return n >= 20 ? { x: Math.round(sx / n), y: Math.round(sy / n), by: 'map', pixels: n } : null;
  }, png);
}

const BASEMAP_RE = /pmtiles|\.pbf|\.mvt|tiles|cartocdn|protomaps|openfreemap|maps\.worldmonitor/;

/** Tracks basemap tile requests, so a shot waits for the map to finish drawing at its new view. */
function trackBasemap(page) {
  const inFlight = new Set();
  let lastChange = Date.now();
  const done = (req) => { if (inFlight.delete(req)) lastChange = Date.now(); };
  page.on('request', (req) => { if (BASEMAP_RE.test(req.url())) { inFlight.add(req); lastChange = Date.now(); } });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return async () => {
    const deadline = Date.now() + 20_000;
    await page.waitForTimeout(800);
    while (Date.now() < deadline && (inFlight.size > 0 || Date.now() - lastChange < 1_500)) await page.waitForTimeout(200);
    await page.waitForTimeout(500);
  };
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const searches = [];
  await page.route('**/api/infrastructure/v1/search-place*', (route) => {
    searches.push(route.request().url());
    return route.fulfill({ json: { places: [PALM], error: '' } });
  });
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  const basemapDrawn = trackBasemap(page);

  page.on('pageerror', (err) => log('pageerror stack', String(err.stack ?? err).slice(0, 600)));
  const sheet = page.locator(SHEET);
  if (!mobile) {
    // The flat map on desktop is deck.gl, which MapContainer refuses on a software GL renderer such as this VM's SwiftShader.
    await page.addInitScript(() => {
      const UNMASKED_RENDERER = 0x9246;
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === UNMASKED_RENDERER ? 'verify renderer' : original.call(this, parameter);
      };
    });
  }
  const theme = process.env.WM_VERIFY_THEME === 'light' ? 'light' : 'dark';
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"', 'worldmonitor-theme': theme } });

  // Before and after a pick from the dashboard's own view, so the map visibly moves to the place.
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  // Phones hide the header search button behind the bottom bar's Search tab.
  await page.locator('#searchBtn:visible, #mobileSearchBtn:visible, button:visible:has-text("Search")').first().click();
  await (await expectVisible('.search-overlay .search-input')).pressSequentially('satellite passes', { delay: 25 });
  await page.locator('.search-overlay .search-result-item[data-command="orbital:search"]').click();
  await page.locator('.search-overlay').waitFor({ state: 'hidden' });
  await expectVisible('.ow-search-input');
  await sheet.locator('.ow-search-input').fill('Palm Jumeirah');
  await sheet.locator('.ow-search-input').press('Enter');
  await expectVisible('.ow-search-result');
  log('url before pick', await page.evaluate(() => location.href));
  await basemapDrawn();
  await shot('before-pick-dashboard-view');
  await sheet.locator('.ow-search-result').first().click();
  await page.waitForFunction(() => document.querySelector('.imagery-evidence-sheet .ies-place')?.textContent?.includes('Palm Jumeirah, Dubai'));
  await settled(page);
  // The page URL keeps the pre-lookup view while the lookup owns the map, so the recentre is read from the reticle.
  const after = new URL(await page.evaluate(() => location.href));
  log('url after pick', after.href);
  if (/25\.1[01]|55\.1[34]/.test(after.search)) throw new Error(`the page URL carries the picked point: ${after.search}`);
  const inMap = async () => {
    const at = await markOnMap(page);
    const map = await page.locator('#mapContainer').boundingBox();
    return at && at.x > map.x && at.x < map.x + map.width && at.y > map.y && at.y < map.y + map.height ? at : null;
  };
  let mark = null;
  for (let tries = 0; tries < 40 && !mark; tries++) {
    mark = await inMap();
    if (!mark) await page.waitForTimeout(250);
  }
  log('reticle after pick', JSON.stringify(mark));
  if (!mark) throw new Error('the map did not bring the picked place into view: no reticle inside the map');
  await basemapDrawn();
  await shot('after-pick-recentred-on-place');
  await sheet.locator('[data-action="close"]').click();
  searches.length = 0;

  await page.goto('about:blank');
  await page.goto(`${base}/dashboard${SHARE_FRAGMENT}`, { waitUntil: 'domcontentloaded' });
  log('opened', `${base}/dashboard${SHARE_FRAGMENT}`);
  await waitForBoot(page, { data: true });
  await waitForMap(page);

  await expectVisible(SHEET);
  const place = async () => (await sheet.locator('.ies-place').textContent()) ?? '';
  if (!(await place()).includes('25.11°N 55.14°E')) throw new Error(`share link did not open the rounded point: ${await place()}`);
  const hash = await page.evaluate(() => location.hash);
  if (hash.includes('orbital=')) throw new Error(`share key left in the live URL: ${hash}`);
  await settled(page);
  log('zone', await sheet.locator('[data-action="zone"]').textContent());
  await basemapDrawn();
  await shot('sheet-from-share-link');
  const hero = sheet.locator('.ow-tile-hero img').first();
  if (await hero.count()) log('hero', await hero.evaluate((img) => `${img.naturalWidth}x${img.naturalHeight} ${img.src.slice(0, 200)}`));

  await sheet.locator('[data-action="change"]').click();
  await expectVisible('.ow-search-input');
  await sheet.locator('.ow-search-input').fill('Palm Jumeirah');
  await sheet.locator('.ow-search-input').press('Enter');
  await expectVisible('.ow-search-result');
  if (searches.length !== 1) throw new Error(`expected one place search request, saw ${searches.length}`);
  await basemapDrawn();
  await shot('change-search-results');
  await sheet.locator('.ow-search-result').first().click();
  await page.waitForFunction(() => document.querySelector('.imagery-evidence-sheet .ies-place')?.textContent?.includes('Palm Jumeirah, Dubai'));
  if (await sheet.locator('.ow-search-input').isVisible()) throw new Error('search row stayed open after the pick');
  await settled(page);
  log('url while open', await page.evaluate(() => location.href));
  // The URL may keep the pre-lookup centre, never the picked point.
  if (/25\.1[01]|55\.1[34]/.test(await page.evaluate(() => location.search))) throw new Error('map URL sync wrote the picked point while the lookup is open');

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }));
  await sheet.locator('[data-action="share"]').click();
  await expectVisible('.ow-share-link');
  const link = await sheet.locator('.ow-share-link').inputValue();
  if (!link.endsWith('#orbital=25.11,55.14')) throw new Error(`share link is not the rounded fragment: ${link}`);
  log('share link', link);
  await sheet.locator('.ow-share-link').evaluate((field) => { field.setSelectionRange(field.value.length, field.value.length); field.scrollLeft = field.scrollWidth; });
  await shot('share-link-rounded-fragment', { locator: sheet });

  await sheet.locator('.ow-search-input').fill('25.112, 55.139');
  await sheet.locator('.ow-search-input').press('Enter');
  // The sheet names a point at two decimals, so the typed point shows as the shared one once the pick closes the search row.
  await page.waitForFunction(() => document.querySelector('.imagery-evidence-sheet [data-slot="search"]')?.hidden
    && document.querySelector('.imagery-evidence-sheet .ies-place')?.textContent?.includes('25.11°N 55.14°E'));
  if (searches.length !== 1) throw new Error('typed coordinates reached the place search route');

  await page.goto('about:blank');
  await page.goto(`${base}/dashboard${SHARE_FRAGMENT}&view=full`, { waitUntil: 'domcontentloaded' });
  log('opened', `${base}/dashboard${SHARE_FRAGMENT}&view=full`);
  await waitForBoot(page, { data: true });
  // The full view is gone; an older link that asks for it opens the sheet and leaves no view in the URL.
  await page.waitForFunction(() => document.querySelector('.imagery-evidence-sheet') && !location.hash.includes('view=full'), null, { timeout: 60_000 });
  await settled(page);
  await basemapDrawn();
  await shot('sheet-from-old-view-full-link');

  const leaks = requests.filter((url) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && /25\.11[0-9]|55\.1[34][0-9]/.test(url));
  if (leaks.length) throw new Error(`point reached a non-archive host: ${leaks.join(', ')}`);
  log('requests checked', requests.length);
}
