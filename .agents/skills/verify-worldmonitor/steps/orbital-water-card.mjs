/**
 * Water card (#10714 item 1): open Lake Kariba from Strategic Water Levels, read the popup's radar
 * water-extent row, then press Open evidence and read the evidence sheet's water card.
 *
 * The reservoir list is the committed e2e fixture. The watched-site read is served with
 * WM_VERIFY_WATER_SUMMARY (a JSON file in the shape `waterExtentSummary` writes, e.g. one made by
 * running the seeder's `makeFetchWaterExtent` for reservoir:kariba), so the radar row shows real
 * Sentinel-1 readings. The drive fails if the site read carries anything but `site_id`, if any
 * non-archive request carries the reservoir's point or core-box centre, or if a row is missing.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the 390px sheet on the SVG map.
 */
import { readFileSync } from 'node:fs';
import { fixtureCatalog } from './orbital-watch.mjs';
import { pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const SITE = { siteId: 'reservoir:kariba', id: 'kariba', name: 'Lake Kariba', lat: -17, lon: 28, centre: { lat: -16.95, lon: 27.9 } };
const READ_PATH = '/api/orbital/v1/get-watched-site-imagery';
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const LEVELS = JSON.parse(readFileSync(new URL('../../../../e2e/fixtures/reservoir-levels.json', import.meta.url), 'utf8'));

function waterExtent() {
  const file = process.env.WM_VERIFY_WATER_SUMMARY;
  if (!file) throw new Error('set WM_VERIFY_WATER_SUMMARY to a water-extent summary JSON file');
  const entry = JSON.parse(readFileSync(file, 'utf8')).reservoirs?.[SITE.siteId];
  if (!entry?.latest) throw new Error(`${file} has no reading for ${SITE.siteId}`);
  const wire = ({ time, ...rest }) => ({ timeMs: Date.parse(time), ...rest });
  return { latest: wire(entry.latest), ...(entry.sameOrbitPrevious && { sameOrbitPrevious: wire(entry.sameOrbitPrevious) }), boxKm2: entry.areaKm2 };
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const extent = waterExtent();
  log('water extent', JSON.stringify(extent));
  const reads = [];
  await page.route(`**${READ_PATH}*`, (route) => {
    reads.push(route.request().url());
    route.fulfill({ json: {
      siteId: SITE.siteId, name: SITE.name, lat: SITE.lat, lon: SITE.lon, evaluatedAt: Date.now() - 3_600_000, stale: false, waterExtent: extent,
    } });
  });
  await page.route('**/api/climate/v1/list-reservoir-levels*', (route) => route.fulfill({ json: LEVELS }));
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const requests = [];
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: {
    'worldmonitor-map-mode': '"flat"',
    'worldmonitor-panels': JSON.stringify({ 'reservoir-levels': { name: 'Strategic Water Levels', enabled: true, priority: 1 } }),
  } });
  await page.goto(`${base}/dashboard?lat=${SITE.lat}&lon=${SITE.lon}&zoom=6&layers=reservoirLevels`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const marker = page.locator(`.wl-marker[data-reservoir-id="${SITE.id}"]`);
  const row = page.locator(`.panel[data-panel="reservoir-levels"] button.wl-row[data-reservoir-id="${SITE.id}"]`);
  if (await marker.count()) await marker.first().evaluate((el) => el.click());
  else { await row.scrollIntoViewIfNeeded(); await row.click(); }
  const popup = page.locator('.map-popup');
  await expectVisible('.map-popup .wl-popup');
  const radar = popup.locator('[data-wl-water-extent] .wl-water-extent-line');
  await radar.first().waitFor({ timeout: 20_000 });
  log('popup radar row', (await popup.locator('[data-wl-water-extent]').innerText()).replace(/\s+/g, ' '));
  const imagery = popup.locator('[data-orbital-imagery]');
  await imagery.locator('[data-orbital-image] img').waitFor({ timeout: 60_000 }).catch(() => log('popup optical image did not load'));
  await page.waitForTimeout(800);
  await popup.locator('[data-wl-water-extent]').scrollIntoViewIfNeeded();
  await shot(`popup-${mobile ? 'mobile' : 'desktop'}`);

  await imagery.locator('[data-orbital-open-evidence]').click();
  await expectVisible('.imagery-evidence-sheet');
  const card = page.locator('.imagery-evidence-sheet .wl-water-card');
  await card.waitFor({ timeout: 60_000 });
  const rows = await card.locator('.wl-water-row').evaluateAll((els) => els.map((el) => `${el.dataset.row}: ${el.querySelector('.wl-water-value').textContent}`));
  log('card rows', JSON.stringify(rows));
  if (rows.length !== 4) throw new Error(`expected four card rows, saw ${rows.length}`);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot(`evidence-${mobile ? 'mobile' : 'desktop'}`);

  if (reads.length < 1) throw new Error('no site read');
  for (const url of reads) {
    const read = new URL(url);
    if ([...read.searchParams.keys()].join() !== 'site_id' || read.searchParams.get('site_id') !== SITE.siteId) throw new Error(`site read was ${read.search}`);
  }
  const leaks = requests.filter((r) => !ARCHIVE_HOSTS.includes(new URL(r.url).hostname)
    && [SITE, SITE.centre].some((p) => pointLeak(`${new URL(r.url).pathname}${new URL(r.url).search} ${r.body}`, p)));
  if (leaks.length) throw new Error(`reservoir point reached a non-archive host: ${leaks.map((r) => r.url).join(', ')}`);
  return { siteReads: reads.length, rows };
}
