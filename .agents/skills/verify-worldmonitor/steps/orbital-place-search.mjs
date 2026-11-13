/**
 * Satellite passes place search: open a share link, search a place by name,
 * share it, and open a view=full link, proving the point reaches no WorldMonitor host.
 * The point is Palm Jumeirah, Dubai, whose fronds make a crop easy to check by eye.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const PALM = { name: 'Palm Jumeirah, Dubai, United Arab Emirates', lat: 25.1124, lon: 55.139, kind: 'island' };
const SHARE_FRAGMENT = '#orbital=25.11,55.14';

async function settled(page) {
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.orbital-watch-sheet');
    return sheet?.querySelector('.ow-headline') && !/Checking archives|Computing passes/.test(sheet.textContent ?? '');
  }, null, { timeout: 120_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.orbital-watch-sheet img')].every((img) => img.complete), null, { timeout: 60_000 });
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

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"' } });
  await page.goto(`${base}/dashboard${SHARE_FRAGMENT}`, { waitUntil: 'domcontentloaded' });
  log('opened', `${base}/dashboard${SHARE_FRAGMENT}`);
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const sheet = page.locator('.orbital-watch-sheet');
  await expectVisible('.orbital-watch-sheet');
  const place = async () => (await sheet.locator('.ow-place').textContent()) ?? '';
  if (!(await place()).includes('25.110°N 55.140°E')) throw new Error(`share link did not open the rounded point: ${await place()}`);
  const hash = await page.evaluate(() => location.hash);
  if (hash.includes('orbital=')) throw new Error(`share key left in the live URL: ${hash}`);
  await settled(page);
  log('zone', await sheet.locator('.ow-zone').textContent());
  await shot('sheet-from-share-link');
  const hero = sheet.locator('.ow-carousel img').first();
  if (await hero.count()) log('hero', await hero.evaluate((img) => `${img.naturalWidth}x${img.naturalHeight} ${img.src.slice(0, 200)}`));

  await sheet.locator('.ow-change').click();
  await expectVisible('.ow-search-input');
  await sheet.locator('.ow-search-input').fill('Palm Jumeirah');
  await sheet.locator('.ow-search-input').press('Enter');
  await expectVisible('.ow-search-result');
  if (searches.length !== 1) throw new Error(`expected one place search request, saw ${searches.length}`);
  await shot('change-search-results');
  await sheet.locator('.ow-search-result').first().click();
  await page.waitForFunction(() => document.querySelector('.ow-place')?.textContent?.includes('Palm Jumeirah, Dubai'));
  if (await sheet.locator('.ow-search-input').isVisible()) throw new Error('search row stayed open after the pick');
  await settled(page);
  log('url while open', await page.evaluate(() => location.href));
  if (/[?&]lat=/.test(await page.evaluate(() => location.search))) throw new Error('map URL sync wrote the centre while the lookup is open');
  await shot('picked-place-recentred-results');

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }));
  await sheet.locator('.ow-share').click();
  await expectVisible('.ow-share-link');
  const link = await sheet.locator('.ow-share-link').inputValue();
  if (!link.endsWith('#orbital=25.11,55.14')) throw new Error(`share link is not the rounded fragment: ${link}`);
  log('share link', link);
  await sheet.locator('.ow-share-link').evaluate((field) => { field.setSelectionRange(field.value.length, field.value.length); field.scrollLeft = field.scrollWidth; });
  await shot('share-link-rounded-fragment', { locator: sheet });

  await sheet.locator('.ow-search-input').fill('25.112, 55.139');
  await sheet.locator('.ow-search-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ow-place')?.textContent?.includes('25.112°N 55.139°E'));
  if (searches.length !== 1) throw new Error('typed coordinates reached the place search route');

  await page.goto('about:blank');
  await page.goto(`${base}/dashboard${SHARE_FRAGMENT}&view=full`, { waitUntil: 'domcontentloaded' });
  log('opened', `${base}/dashboard${SHARE_FRAGMENT}&view=full`);
  await waitForBoot(page, { data: true });
  await page.waitForFunction(() => document.querySelector('.orbital-watch-sheet')?.getAttribute('data-view') === 'full', null, { timeout: 60_000 });
  await settled(page);
  await shot('full-view-from-view-full-link');

  const leaks = requests.filter((url) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && /25\.11[0-9]|55\.1[34][0-9]/.test(url));
  if (leaks.length) throw new Error(`point reached a non-archive host: ${leaks.join(', ')}`);
  log('requests checked', requests.length);
}
