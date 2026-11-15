/**
 * Watched-site block in the evidence sheet (#10713 unit 1): open the lookup on
 * Al Udeid through its two-decimal route and read the site's daily record.
 *
 * The site is matched in the browser, so the drive fails if the site read
 * carries anything but `site_id`, if a non-archive request carries the point,
 * or if a change-flag row renders. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the
 * 390px bottom sheet.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const SITE = { siteId: 'military-base:al_udeid', name: 'Al Udeid', lat: 25.2793, lon: 51.5224 };
const READ_PATH = '/api/orbital/v1/get-watched-site-imagery';
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const COORD = /25\.2[78]|51\.52/;

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const reads = [];
  await page.route(`**${READ_PATH}*`, (route) => {
    reads.push(route.request().url());
    route.fulfill({ json: {
      siteId: SITE.siteId, name: SITE.name, lat: SITE.lat, lon: SITE.lon, evaluatedAt: Date.now() - 3_600_000, stale: false,
      latestImage: { itemId: 'S2C_MSIL2A_VERIFY', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', datetime: new Date(Date.now() - 30 * 3_600_000).toISOString() },
      nextPass: { satellite: 'SENTINEL-2C', profileId: 'sentinel-2', time: new Date(Date.now() + 9 * 3_600_000).toISOString() },
    } });
  });
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const requests = [];
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page);
  await page.goto(`${base}/dashboard?view=global#orbital=${SITE.lat.toFixed(2)},${SITE.lon.toFixed(2)}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await expectVisible('.imagery-evidence-sheet');
  await page.waitForFunction(() => /Checked/.test([...document.querySelectorAll('.imagery-evidence-sheet [data-section="site"] .ies-cell')].map((c) => c.dataset.label).join(' ')), null, { timeout: 30_000 });
  const read = await page.evaluate(() => ({
    title: document.querySelector('.imagery-evidence-sheet .ies-place')?.textContent,
    subline: document.querySelector('.imagery-evidence-sheet .ies-coords')?.textContent,
    block: document.querySelector('.imagery-evidence-sheet [data-section="site"]')?.textContent,
    order: [...document.querySelectorAll('.imagery-evidence-sheet .ies-body > *')].map((el) => el.dataset.section ?? el.dataset.slot),
  }));
  log('sheet', JSON.stringify(read));
  // Archive answers re-render the sheet body, so scroll to the block as it stands when the shot is taken.
  await page.waitForTimeout(3_000);
  await page.evaluate(() => document.querySelector('.imagery-evidence-sheet [data-section="site"]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await shot('site-block');

  if (read.title !== SITE.name) throw new Error(`sheet title is ${read.title}, not the site name`);
  if (!/Monitored site/.test(read.subline ?? '')) throw new Error('subline does not mark the monitored site');
  if (/changed/i.test(read.block ?? '')) throw new Error('a change-flag row rendered');
  log('site reads', JSON.stringify(reads));
  if (reads.length !== 1) throw new Error(`expected one site read, saw ${reads.length}`);
  const params = [...new URL(reads[0]).searchParams.keys()];
  if (params.join() !== 'site_id' || new URL(reads[0]).searchParams.get('site_id') !== SITE.siteId) throw new Error(`site read carried ${reads[0]}`);
  const leaks = requests.filter(({ url, body }) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && !url.startsWith('blob:') && !url.startsWith('data:')
    && (COORD.test(decodeURIComponent(url)) || COORD.test(body)));
  log('non-archive requests carrying the point', leaks.length, leaks.slice(0, 3).map((l) => l.url).join(' '));
  if (leaks.length) throw new Error(`the point reached a non-archive host: ${leaks[0].url}`);
  return { mobile, read, reads: reads.length };
}
