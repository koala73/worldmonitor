/**
 * Before and after around a map event (#10713 unit 2): click a FIRMS fire detection dated
 * twenty days ago and read its imagery row's before/after action.
 *
 * WM_VERIFY_EVENT_ACCESS=free (default pro) drives a free user: the row must show the Pro
 * link and make no history search. Pro answers the tester-key session status (`GET /api/wm-session`)
 * with a Pro session, as an accepted `wm-pro-key` would on a deployment, presses Before / after, and waits for the viewer to open in compare with the event marked.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the 390px sheet on the SVG map. The drive fails if
 * a request the popup makes carries the fire's point to a non-archive host.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const FIRE = { lat: 48.5, lon: 37.25 };
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const DAY_MS = 86_400_000;

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const pro = process.env.WM_VERIFY_EVENT_ACCESS !== 'free';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
  const detectedAt = Date.parse(`${new Date(Date.now() - 20 * DAY_MS).toISOString().slice(0, 10)}T10:42:00Z`);
  await page.route('**/api/wildfire/v1/list-fire-detections*', (route) => route.fulfill({ json: {
    fetchedAt: Date.now() - 60_000, dataAvailable: true,
    fireDetections: [{
      id: 'verify-fire-1', location: { latitude: FIRE.lat, longitude: FIRE.lon }, brightness: 352, frp: 12.3, confidence: 'FIRE_CONFIDENCE_HIGH',
      satellite: 'N', detectedAt, region: 'Ukraine', dayNight: 'D', source: 'firms', kind: 'active', emergency: true,
    }],
  } }));
  if (pro) {
    await page.route('**/api/wm-session*', (route) => (route.request().method() === 'GET'
      ? route.fulfill({ json: { widget: false, pro: true } }) : route.continue()));
  }
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  if (!mobile) {
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === 0x9246 ? 'verify renderer' : original.call(this, parameter);
      };
    });
  }
  const requests = [];
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"', ...(pro ? { 'wm-key-session-check': '1' } : {}) } });
  await page.goto(`${base}/dashboard?lat=${FIRE.lat}&lon=${FIRE.lon}&zoom=${mobile ? 6 : 8}&layers=fires,natural&timeRange=all`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer, 'detection', new Date(detectedAt).toISOString());
  await page.waitForTimeout(2500);

  const popup = page.locator('.map-popup');
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
  const row = popup.locator('[data-orbital-imagery]');
  await row.waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector('[data-orbital-imagery] .popup-imagery-status')?.textContent?.includes('Checking'), null, { timeout: 60_000 });
  log('row text', (await row.innerText()).replace(/\s+/g, ' '));
  const view = mobile ? 'mobile' : 'desktop';

  if (!pro) {
    const link = row.locator('[data-orbital-event-compare-locked]');
    await link.waitFor({ timeout: 10_000 });
    if ((await link.getAttribute('href')) !== '/pro#pricing') throw new Error('the Pro link does not point at pricing');
    if (await row.locator('[data-orbital-event-compare]').count()) throw new Error('a free user got the compare button');
    await link.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(`event-locked-${view}`);
  } else {
    const button = row.locator('[data-orbital-event-compare]');
    await button.waitFor({ timeout: 10_000 });
    await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(`event-row-${view}`);
    await button.click();
    log('status', await row.locator('[data-orbital-event-status]').innerText().catch(() => ''));
    const opened = await page.locator('img.oiv-before').waitFor({ timeout: 90_000 }).then(() => true, () => false);
    if (!opened) {
      log('status after wait', await row.locator('[data-orbital-event-status]').innerText().catch(() => '(popup closed)'));
      await shot(`event-no-pair-${view}`);
      throw new Error('the viewer did not open on a before/after pair');
    }
    await page.waitForFunction(() => [...document.querySelectorAll('img.oiv-before, img.oiv-after')].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 60_000 }).catch(() => {});
    log('event mark', await page.locator('.oiv-event').innerText());
    log('dates', (await page.locator('.oiv-dates').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(800);
    await shot(`event-compare-${view}`);
  }

  const leaks = requests.slice(fromClick).filter((r) => {
    const url = new URL(r.url);
    return !ARCHIVE_HOSTS.includes(url.hostname) && (pointLeak(url.pathname + url.search, FIRE) || pointLeak(r.body, FIRE));
  });
  if (leaks.length) throw new Error(`the fire's coordinates reached a non-archive host: ${leaks.map((r) => r.url).join(', ')}`);
  const searches = requests.slice(fromClick).filter((r) => /\/search\b/.test(new URL(r.url).pathname) && ARCHIVE_HOSTS.includes(new URL(r.url).hostname));
  for (const r of searches) log('archive search', new URL(r.url).hostname, (r.body || new URL(r.url).search).replace(/\s+/g, '').slice(0, 220));
  const historySearches = searches.length;
  return { renderer, pro, leaks: leaks.length, historySearches };
}
