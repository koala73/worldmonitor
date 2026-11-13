/**
 * Satellite passes place search: open a share link, search a place by name,
 * and try the device location, proving the point reaches no WorldMonitor host.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const ROTTERDAM = { name: 'Rotterdam, South Holland, Netherlands', lat: 51.9244, lon: 4.4777, kind: 'city' };

export default async function ({ page, base, shot, log, expectVisible }) {
  if (process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const searches = [];
  await page.route('**/api/infrastructure/v1/search-place*', (route) => {
    searches.push(route.request().url());
    return route.fulfill({ json: { places: [ROTTERDAM], error: '' } });
  });
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard#orbital=25.20,55.27`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const sheet = page.locator('.orbital-watch-sheet');
  await expectVisible('.orbital-watch-sheet');
  if (!(await sheet.locator('.ow-point').textContent())?.includes('25.200°N, 55.270°E')) throw new Error('share link did not open the rounded point');
  const hash = await page.evaluate(() => location.hash);
  if (hash.includes('orbital=')) throw new Error(`share key left in the live URL: ${hash}`);
  await sheet.locator('.ow-headline').waitFor({ timeout: 60_000 });
  await shot('share-link-opened');

  await sheet.locator('.ow-search-input').fill('Rotterdam');
  await sheet.locator('.ow-search-input').press('Enter');
  await expectVisible('.ow-search-result');
  if (searches.length !== 1) throw new Error(`expected one place search request, saw ${searches.length}`);
  await shot('search-results');
  await sheet.locator('.ow-search-result').first().click();
  await page.waitForFunction(() => document.querySelector('.ow-point')?.textContent?.includes('51.924°N'));
  log('url while open', await page.evaluate(() => location.href));
  if (/[?&]lat=/.test(await page.evaluate(() => location.search))) throw new Error('map URL sync wrote the centre while the lookup is open');

  await sheet.locator('.ow-search-input').fill('25.2048, 55.2708');
  await sheet.locator('.ow-search-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ow-point')?.textContent?.includes('25.205°N'));
  if (searches.length !== 1) throw new Error('typed coordinates reached the place search route');

  await page.context().clearPermissions();
  await sheet.locator('.ow-locate').click();
  await page.waitForFunction(() => /permission was denied|could not be found/.test(document.querySelector('.ow-search-status')?.textContent ?? ''), null, { timeout: 15_000 });
  await shot('locate-denied');

  await sheet.locator('.ow-share').click();
  await shot('share-copied');

  const leaks = requests.filter((url) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && /25\.20[0-9]|55\.27[0-9]|51\.92|4\.47/.test(url));
  if (leaks.length) throw new Error(`point reached a non-archive host: ${leaks.join(', ')}`);
  log('requests checked', requests.length);
}
