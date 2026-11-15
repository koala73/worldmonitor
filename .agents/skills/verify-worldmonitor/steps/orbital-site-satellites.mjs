/**
 * A watched site's evidence sheet lists the tracked satellites covering it
 * (#10713 unit 3). Opens Al Udeid through its two-decimal share route, serves
 * the satellite layer's element sets from CelesTrak's current earth-resources
 * group, and reads the sheet's site-satellites section. It fails if the section
 * does not answer, or if any non-archive request carries the site's coordinates.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives the 390px bottom sheet.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fixtureCatalog } from './orbital-watch.mjs';
import { pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const SITE = { lat: 25.28, lon: 51.52 };
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];

// CelesTrak asks clients not to download a group more than once every two hours.
const TLE_CACHE = new URL('../../../../.claude/verify-evidence/celestrak-resource.tle', import.meta.url);

async function resourceText() {
  try {
    if (Date.now() - statSync(TLE_CACHE).mtimeMs < 2 * 3_600_000) return readFileSync(TLE_CACHE, 'utf8');
  } catch { /* no cached copy yet */ }
  const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=tle', { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`CelesTrak answered ${res.status}`);
  const text = await res.text();
  mkdirSync(new URL('.', TLE_CACHE), { recursive: true });
  writeFileSync(TLE_CACHE, text);
  return text;
}

async function resourceTles() {
  const lines = (await resourceText()).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const satellites = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, line1, line2] = lines.slice(i, i + 3);
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    satellites.push({ id: line1.slice(2, 7).trim(), name: name.trim(), country: '', type: 'civil', alt: 0, velocity: 0, inclination: 0, line1, line2 });
  }
  return satellites;
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const satellites = await resourceTles();
  log('element sets served', satellites.length);
  await page.route('**/api/intelligence/v1/list-satellites*', (route) => route.fulfill({ json: { satellites } }));
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  const requests = [];
  page.on('request', (req) => req.resourceType() !== 'document' && requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard?view=global#orbital=${SITE.lat.toFixed(2)},${SITE.lon.toFixed(2)}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));
  await expectVisible('.imagery-evidence-sheet');
  const section = page.locator('[data-section="site-satellites"]');
  await section.waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('[data-section="site-satellites"]')?.getAttribute('data-state') !== 'projecting', null, { timeout: 120_000 });
  const state = await section.getAttribute('data-state');
  log('site', await section.getAttribute('data-site-id'), 'state', state);
  if (state !== 'ok') throw new Error(`site-satellites answered ${state}`);
  const rows = await section.locator('[data-norad-id]').count();
  const shown = await section.locator('[data-norad-id]:visible').count();
  log('rows', rows, 'shown', shown, 'linked', await section.locator('.ies-row').count());
  if (rows > 6 && shown !== 6) throw new Error(`a folded list shows ${shown} of ${rows} rows`);
  log('section text', (await section.innerText()).replace(/\s+/g, ' ').slice(0, 600));
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(`site-satellites-${mobile ? 'mobile' : 'desktop'}`);

  const more = section.locator('.ies-more');
  if (await more.count()) await more.click();
  const linked = section.locator('.ies-row').first();
  if (!(await linked.count())) throw new Error('no satellite over the site is linked to a pass in the sheet');
  await linked.scrollIntoViewIfNeeded();
  const key = await linked.getAttribute('data-key');
  await linked.click();
  await page.waitForFunction((k) => document.querySelector(`[data-section="site-satellites"] [data-key="${k}"][aria-current="true"]`), key, { timeout: 10_000 });
  log('selected', (await section.locator('.ies-row[aria-current="true"]').innerText()).replace(/\s+/g, ' '));
  await page.waitForTimeout(2_500);
  await shot(`site-satellites-selected-${mobile ? 'mobile' : 'desktop'}`);

  const leaks = requests.filter((r) => {
    const url = new URL(r.url);
    return !ARCHIVE_HOSTS.includes(url.hostname) && pointLeak(`${url.pathname}${url.search}\n${r.body}`, SITE) !== null;
  });
  if (leaks.length) throw new Error(`site coordinates reached a non-archive host: ${leaks.map((r) => r.url).join(', ')}`);
  return { state, leaks: leaks.length };
}
