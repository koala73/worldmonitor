/**
 * FIRMS fire detection popup (#10713): click a satellite fire detection and read
 * its facts, the NASA GIBS daily mosaic of the detection's date, and the imagery row.
 *
 * The detection is a test row served from the wildfire list route, dated on the newest
 * UTC day the real GIBS archive holds a VIIRS Suomi NPP mosaic for (the `natural` layer is
 * on only because it is what makes the dashboard load fires from the URL). WM_VERIFY_FIRE_STATE=none
 * empties GIBS's time domain so the popup must show no mosaic image and say why.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the 390px sheet on the SVG map;
 * WM_VERIFY_ORBITAL_THEME=light drives the light theme. The drive fails if the popup
 * paints an image from anything but a blob: URL, if the empty state still shows an
 * image or does not say GIBS has no mosaic for the date, or if a request the popup makes
 * carries the fire's point (as a pair or a box midpoint) to a non-archive host.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const FIRE = { lat: 48.5, lon: 37.25 };
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const DAY_MS = 86_400_000;

/** The newest UTC day the archive holds a VIIRS Suomi NPP mosaic for; GIBS can lag the calendar by days. */
async function newestMosaicDay() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/250m/all/${iso(Date.now() - 30 * DAY_MS)}--${iso(Date.now())}.xml`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  // An outage must read as an outage, not as an archive with no recent mosaic.
  if (!res.ok) throw new Error(`GIBS capabilities request failed: HTTP ${res.status} ${res.statusText}`.trim());
  const text = await res.text();
  const last = [...text.matchAll(/<Domain>([^<]*)<\/Domain>/g)].flatMap((m) => m[1].split(',')).map((part) => part.split('/')[1]).filter(Boolean).pop();
  if (!last) throw new Error('GIBS lists no VIIRS Suomi NPP mosaic day in the last 30 days');
  return last;
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  const empty = process.env.WM_VERIFY_FIRE_STATE === 'none';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 });

  // The empty state dates the detection yesterday; the image state dates it on the newest day GIBS holds.
  const day = empty ? new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) : await newestMosaicDay();
  const detectedAt = Date.parse(`${day}T10:42:00Z`);
  log('detection date', day);
  await page.route('**/api/wildfire/v1/list-fire-detections*', (route) => route.fulfill({ json: {
    fetchedAt: Date.now() - 60_000, dataAvailable: true,
    fireDetections: [{
      id: 'verify-fire-1', location: { latitude: FIRE.lat, longitude: FIRE.lon }, brightness: 352, frp: 12.3, confidence: 'FIRE_CONFIDENCE_HIGH',
      satellite: 'N', detectedAt, region: 'Ukraine', dayNight: 'D', source: 'firms', kind: 'active', emergency: true,
    }],
  } }));
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  if (empty) {
    await page.route((url) => url.hostname === 'gibs.earthdata.nasa.gov' && url.pathname.endsWith('.xml'), (route) =>
      route.fulfill({ contentType: 'text/xml', body: '<Domain>2020-01-01/2020-01-02/P1D</Domain>' }));
  }
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
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"', 'worldmonitor-theme': theme } });
  await page.goto(`${base}/dashboard?lat=${FIRE.lat}&lon=${FIRE.lon}&zoom=${mobile ? 6 : 8}&layers=fires,natural&timeRange=all`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  await page.waitForTimeout(2500);

  const popup = page.locator('.map-popup');
  // The map opens centred on the fire, so start-up viewport requests carry it by design; check the popup's own.
  const fromClick = requests.length;
  if (renderer === 'svg') {
    await page.locator('.fire-dot-popup').first().waitFor({ state: 'attached', timeout: 30_000 });
    await page.locator('.fire-dot-popup').first().evaluate((el) => el.click());
  } else {
    const box = await page.locator('#deckgl-overlay, #mapContainer canvas').first().boundingBox();
    for (const [dx, dy] of [[0, 0], [0, -4], [0, 4], [-4, 0], [4, 0], [0, -8]]) {
      await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
      if (await popup.isVisible().catch(() => false)) break;
      await page.waitForTimeout(400);
    }
  }
  await expectVisible('.map-popup');
  const mosaic = popup.locator('[data-fire-mosaic]');
  await mosaic.waitFor({ timeout: 15_000 });
  log('facts', (await popup.locator('.popup-stats').first().innerText()).replace(/\s+/g, ' '));
  if (empty) {
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-fire-mosaic] .popup-imagery-status')?.textContent?.trim() ?? '';
      return text !== '' && !text.includes('Checking');
    }, null, { timeout: 30_000 });
    if (await mosaic.locator('img').count()) throw new Error('the empty state still shows a mosaic image');
    // Only the no-mosaic sentence for the detection's date passes; an archive error or a blank body fails.
    const status = (await mosaic.locator('.popup-imagery-status').innerText()).trim();
    const date = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${day}T00:00:00Z`));
    if (/^NASA GIBS has no .+ mosaic for (.+)\.$/.exec(status)?.[1] !== date) {
      throw new Error(`the empty state says ${JSON.stringify(status)}, not that GIBS has no mosaic for ${date}`);
    }
  } else {
    await mosaic.locator('[data-fire-mosaic-image] img').waitFor({ timeout: 60_000 });
    const src = await mosaic.locator('img').getAttribute('src');
    if (!src?.startsWith('blob:')) throw new Error(`mosaic painted from ${src}`);
  }
  log('mosaic text', (await mosaic.innerText()).replace(/\s+/g, ' '));
  const row = popup.locator('[data-orbital-imagery]');
  await row.waitFor({ timeout: 15_000 });
  // An unavailable or error state is a finished row; a row still checking after 60 s fails the drive.
  await page.waitForFunction(() => !document.querySelector('[data-orbital-imagery] .popup-imagery-status')?.textContent?.includes('Checking'), null, { timeout: 60_000 })
    .catch(() => { throw new Error('the imagery row was still checking after 60 s'); });
  log('row text', (await row.innerText()).replace(/\s+/g, ' '));
  await popup.evaluate((el) => { el.scrollTop = 0; });
  await shot(`fire-${empty ? 'none' : 'image'}-${mobile ? 'mobile' : 'desktop'}-${theme}`);

  const leaks = requests.slice(fromClick).filter((r) => {
    const url = new URL(r.url);
    return !ARCHIVE_HOSTS.includes(url.hostname) && (pointLeak(url.pathname + url.search, FIRE) || pointLeak(r.body, FIRE));
  });
  if (leaks.length) throw new Error(`the fire's coordinates reached a non-archive host: ${leaks.map((r) => r.url).join(', ')}`);
  return { renderer, empty, leaks: leaks.length };
}
