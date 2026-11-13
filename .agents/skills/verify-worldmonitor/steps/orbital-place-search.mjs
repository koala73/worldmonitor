/**
 * Satellite passes place search: open a share link, search a place by name,
 * and try the device location, proving the point reaches no WorldMonitor host.
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
  if (process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const searches = [];
  await page.route('**/api/infrastructure/v1/search-place*', (route) => {
    searches.push(route.request().url());
    return route.fulfill({ json: { places: [PALM], error: '' } });
  });
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard${SHARE_FRAGMENT}`, { waitUntil: 'domcontentloaded' });
  log('opened', `${base}/dashboard${SHARE_FRAGMENT}`);
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const sheet = page.locator('.orbital-watch-sheet');
  await expectVisible('.orbital-watch-sheet');
  if (!(await sheet.locator('.ow-point').textContent())?.includes('25.110°N, 55.140°E')) throw new Error('share link did not open the rounded point');
  const hash = await page.evaluate(() => location.hash);
  if (hash.includes('orbital=')) throw new Error(`share key left in the live URL: ${hash}`);
  await settled(page);
  await shot('share-link-opened-25.11N-55.14E', { locator: sheet });
  const crop = sheet.locator('.ow-row-image').first();
  if (await crop.count()) {
    await crop.scrollIntoViewIfNeeded();
    log('crop', await crop.locator('img').evaluate((img) => `${img.naturalWidth}x${img.naturalHeight} ${img.src.slice(0, 160)}`));
    await shot('confirmed-image-crop', { locator: crop });
  } else {
    log('crop', 'no confirmed image at this point');
  }

  await sheet.locator('.ow-search-input').fill('Palm Jumeirah');
  await sheet.locator('.ow-search-input').press('Enter');
  await expectVisible('.ow-search-result');
  if (searches.length !== 1) throw new Error(`expected one place search request, saw ${searches.length}`);
  await shot('search-results-palm-jumeirah', { locator: sheet });
  await sheet.locator('.ow-search-result').first().click();
  await page.waitForFunction(() => document.querySelector('.ow-point')?.textContent?.includes('25.112°N'));
  await settled(page);
  log('url while open', await page.evaluate(() => location.href));
  if (/[?&]lat=/.test(await page.evaluate(() => location.search))) throw new Error('map URL sync wrote the centre while the lookup is open');
  await shot('search-picked-map-recentred');

  await sheet.locator('.ow-search-input').fill('25.112, 55.139');
  await sheet.locator('.ow-search-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ow-point')?.textContent?.includes('25.112°N, 55.139°E'));
  if (searches.length !== 1) throw new Error('typed coordinates reached the place search route');

  await page.context().clearPermissions();
  await sheet.locator('.ow-locate').click();
  await page.waitForFunction(() => /permission was denied|could not be found/.test(document.querySelector('.ow-search-status')?.textContent ?? ''), null, { timeout: 15_000 });
  await settled(page);
  await shot('locate-denied', { locator: sheet });

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }));
  await sheet.locator('.ow-share').click();
  const link = await sheet.locator('.ow-share-link').inputValue();
  if (!link.endsWith(SHARE_FRAGMENT)) throw new Error(`share link is not the rounded fragment: ${link}`);
  log('share link', link);
  await sheet.locator('.ow-share-link').evaluate((field) => { field.setSelectionRange(field.value.length, field.value.length); field.scrollLeft = field.scrollWidth; });
  await shot('share-link-field-rounded-fragment', { locator: sheet });

  const leaks = requests.filter((url) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && /25\.11[0-9]|55\.1[34][0-9]/.test(url));
  if (leaks.length) throw new Error(`point reached a non-archive host: ${leaks.join(', ')}`);
  log('requests checked', requests.length);
}
