/**
 * Candidate manoeuvres (#9110) on a watched site's satellite rows and on a tracked
 * satellite's card. Serves the satellite layer's element sets from CelesTrak's current
 * earth-resources group and a stubbed /api/orbital/v1/list-satellite-maneuvers that gives
 * every third satellite a recent candidate, so marked and unmarked rows sit side by side.
 * It fails if no site row carries the marker, if an unmarked row does, or if the card of
 * a marked satellite shows no candidate line or its receipt. WM_VERIFY_ORBITAL_VIEWPORT=mobile drives 390px.
 */
import { resourceTles } from './orbital-site-satellites.mjs';
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const SITE = { lat: 25.28, lon: 51.52 };
const DAY_MS = 86_400_000;
// Realistic steps: each moves its own element in the after set and crosses its regime floor.
const ELEMENTS = [
  { element: 'semiMajorAxis', unit: 'km', residual: 1.2, threshold: 0.2, change: { semiMajorAxisKm: 1.2 } },
  { element: 'inclination', unit: 'deg', residual: -0.031, threshold: 0.01, change: { inclination: -0.031 } },
  { element: 'raan', unit: 'deg', residual: 0.15, threshold: 0.02, change: { raan: 0.985 + 0.15 } },
];

const marked = (id) => Number(id) % 3 === 0;

function stubManeuvers(satellites) {
  const toEpoch = Date.now() - DAY_MS;
  const fromEpoch = Date.now() - 2 * DAY_MS;
  const base = { meanMotion: 14.3, semiMajorAxisKm: 7164.1, eccentricity: 0.0001, inclination: 98.56, raan: 28.3, bstar: 0.0001 };
  const after = (change) => ({ ...base, ...Object.fromEntries(Object.entries(change).map(([k, d]) => [k, base[k] + d])), epoch: toEpoch });
  const candidates = satellites.filter((s) => marked(s.id)).map((s, i) => {
    const { change, ...step } = ELEMENTS[i % ELEMENTS.length];
    return {
      noradId: Number(s.id), regime: 'leo', fromEpoch, toEpoch, confirmedByEpoch: Date.now() - DAY_MS / 4,
      expected: 0, observed: 0, before: { ...base, epoch: fromEpoch }, after: after(change), ...step,
    };
  });
  return {
    candidates,
    satellites: satellites.map((s) => ({ noradId: Number(s.id), status: 'evaluated', regime: 'leo', candidateCount: marked(s.id) ? 1 : 0 })),
    evaluatedSatellites: satellites.length, generatedAt: Date.now(), detectionVersion: 1, methodNote: 'stubbed for verification', stale: false,
  };
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const tag = mobile ? 'mobile' : 'desktop';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const satellites = await resourceTles();
  const byName = new Map(satellites.map((s) => [s.name, s.id]));
  log('element sets served', satellites.length, 'marked', satellites.filter((s) => marked(s.id)).length);
  await page.route('**/api/intelligence/v1/list-satellites*', (route) => route.fulfill({ json: { satellites } }));
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: fixtureCatalog() }));
  let maneuverReads = 0;
  await page.route('**/api/orbital/v1/list-satellite-maneuvers*', (route) => {
    maneuverReads++;
    return route.fulfill({ json: stubManeuvers(satellites) });
  });

  // 1. The site sheet: each row of a marked satellite says so, the others do not.
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard?view=global#orbital=${SITE.lat.toFixed(2)},${SITE.lon.toFixed(2)}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));
  await expectVisible('.imagery-evidence-sheet');
  const section = page.locator('[data-section="site-satellites"]');
  await section.waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('[data-section="site-satellites"]')?.getAttribute('data-state') === 'ok', null, { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('[data-section="site-satellites"] [data-maneuver]'), null, { timeout: 30_000 });
  const rows = await section.locator('[data-norad-id]').evaluateAll((els) => els.map((el) => ({
    id: el.getAttribute('data-norad-id'), maneuver: el.getAttribute('data-maneuver'), text: el.textContent ?? '',
  })));
  const wrong = rows.filter((r) => Boolean(r.maneuver) !== marked(r.id) || r.text.includes('candidate maneuver') !== marked(r.id));
  log('site rows', rows.length, 'marked', rows.filter((r) => r.maneuver).length, 'wrong', wrong.length);
  if (!rows.some((r) => r.maneuver)) throw new Error('no satellite row over the site carries the candidate marker');
  if (wrong.length) throw new Error(`rows marked against the stub: ${wrong.map((r) => r.id).join(', ')}`);
  const more = section.locator('.ies-more');
  if (await more.count()) await more.click();
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(`maneuver-site-rows-${tag}`);

  // 2. The satellite card: a marked satellite's card has the candidate line under its sites heading.
  await page.goto(`${base}/dashboard?view=global&layers=satellites`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  await waitForMap(page);
  await page.waitForFunction(() => document.querySelectorAll('.sat-hit').length > 0, null, { timeout: 60_000 });
  // The detector only judges profiled imaging satellites, so the card is opened on one of those.
  // Satellites move: wait up to a minute for a marked one to be on screen.
  const pick = () => page.evaluate((names) => {
    const w = window.innerWidth; const h = window.innerHeight;
    const onScreen = [];
    for (const hit of document.querySelectorAll('.sat-hit')) {
      const name = hit.parentElement?.title ?? '';
      const r = hit.getBoundingClientRect();
      if (names.includes(name) && r.width > 0 && r.left > 40 && r.top > 120 && r.right < w - (w < 600 ? 40 : 340) && r.bottom < h - 200) onScreen.push(name);
    }
    return onScreen.find((n) => /YAOGAN|GAOFEN|SENTINEL|LANDSAT|COSMO|CSG|JILIN|ICEYE|WORLDVIEW|PLEIADES/i.test(n)) ?? onScreen[0] ?? null;
  }, satellites.filter((s) => marked(s.id)).map((s) => s.name));
  let target = await pick();
  for (let tries = 0; !target && tries < 12; tries++) {
    await page.waitForTimeout(5_000);
    target = await pick();
  }
  if (!target) throw new Error('no marked satellite is on screen to click');
  log('clicking', target, byName.get(target));
  await page.locator(`[title="${target.replace(/"/g, '\\"')}"] .sat-hit`).first().click({ force: true });
  const card = page.locator('.osat-card');
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('.osat-card [data-osat-sites]')?.hasAttribute('data-coverage'), null, { timeout: 60_000 });
  const line = card.locator('.osat-sites-maneuver');
  // The line follows the coverage list once the candidate read answers.
  await line.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {
    throw new Error(`the card of ${target} shows no candidate line`);
  });
  log('card line', await line.locator('summary').innerText());
  // The line opens to its receipt: both element sets' values, the step off the trend, the threshold and the epochs.
  await line.locator('summary').click();
  const receipt = line.locator('.osat-sites-maneuver-receipt');
  await receipt.waitFor({ state: 'visible', timeout: 5_000 });
  const receiptText = await receipt.innerText();
  log('receipt', receiptText);
  if (!/→.*threshold.*UTC/.test(receiptText)) throw new Error(`the receipt does not show the element sets and threshold: ${receiptText}`);
  // On a phone the card sits in the short map strip and scrolls; bring the receipt into its view, as a user would.
  await receipt.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await shot(`maneuver-satellite-card-${tag}`);
  return { siteRows: rows.length, markedRows: rows.filter((r) => r.maneuver).length, card: target, maneuverReads };
}
