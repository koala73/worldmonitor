/**
 * Satellite passes here, ground track: pick a pass in the lookup sheet and see
 * its ground track, sensor footprint and replay marker on the map.
 *
 * WM_VERIFY_ORBITAL_MAP=flat drives the flat map: deck.gl on desktop, the SVG
 * map on phones. Headless Chromium has only software GL, which MapContainer
 * refuses for deck.gl, so flat mode hides the renderer name from that check.
 * The lookup opens from its shared link, #orbital=<lat>,<lon>, so the pin sits
 * on the exact point on every renderer.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_POINT=fiji looks up a point by the antimeridian instead of Palm Jumeirah.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';

export default async function ({ page, base, shot: capture, log, expectVisible }) {
  const shot = async (name) => {
    await page.evaluate(() => document.querySelector('.orbital-watch-sheet .ow-body')?.scrollTo(0, 0));
    await capture(name);
  };
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const flat = process.env.WM_VERIFY_ORBITAL_MAP === 'flat';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.route(`**${CATALOG_PATH}*`, (route) => route.fulfill({ json: fixtureCatalog() }));
  if (flat) {
    await page.addInitScript(() => {
      const UNMASKED_RENDERER = 0x9246;
      const original = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        return parameter === UNMASKED_RENDERER ? 'verify renderer' : original.call(this, parameter);
      };
    });
  }
  const requests = [];
  page.on('request', (req) => requests.push({ url: req.url(), body: req.postData() ?? '' }));

  const fiji = process.env.WM_VERIFY_ORBITAL_POINT === 'fiji';
  const at = fiji ? { lat: -16.85, lon: 179.95 } : { lat: 25.112, lon: 55.139 };
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': flat ? '"flat"' : '"globe"' } });
  const startUrl = `${base}/dashboard?lat=${at.lat}&lon=${at.lon}&zoom=${flat ? 7 : 4}&layers=none#orbital=${at.lat},${at.lon}`;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  const expected = flat ? (mobile ? 'svg' : 'deckgl') : 'globe';
  if (renderer !== expected) throw new Error(`expected the ${expected} map, got ${renderer}`);
  const sheet = await expectVisible('.orbital-watch-sheet');
  const collapse = page.locator('#mapContainer .toggle-collapse:visible').first();
  if (await collapse.count()) await collapse.click().catch(() => {});
  const pointText = await sheet.locator('.ow-place').innerText();
  log('picked point', pointText);
  const replays = sheet.locator('.ow-card .ow-replay');
  await replays.first().waitFor({ timeout: 120_000 });
  await sheet.locator('.ow-steps, .ow-progress').first().waitFor({ state: 'detached', timeout: 120_000 }).catch(() => {});
  const cards = await sheet.locator('.ow-card:has(.ow-replay)').evaluateAll((els) => els.map((el) => ({
    sensor: el.querySelector('[data-sensor]')?.getAttribute('data-sensor') ?? '', src: el.querySelector('img')?.getAttribute('src') ?? '',
  })));
  log('replayable cards', JSON.stringify(cards));
  const radar = cards.findIndex((card) => /sentinel-1/i.test(card.sensor));
  const optical = cards.findIndex((card) => /sentinel-2|landsat/i.test(card.sensor));
  const firstIndex = optical >= 0 ? optical : 0;
  const hud = page.locator('[data-slot="replay-hud"] .ow-replay-hud');
  const play = async (index) => {
    await replays.nth(index).scrollIntoViewIfNeeded();
    await replays.nth(index).click();
    await hud.waitFor();
    return hud.locator('.ow-hud-label').innerText();
  };
  const firstName = await play(firstIndex);
  log('replaying', firstName, 'crop', cards[firstIndex]?.src);
  await page.waitForTimeout(2_500);
  await shot('replay-in-progress');
  await page.waitForTimeout(7_000);
  await shot('replay-at-closest-approach-acquired');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await play(firstIndex);
  await page.locator('[data-slot="replay-hud"] .ow-hud-reduced:visible').first().waitFor();
  await page.waitForTimeout(800);
  await shot('reduced-motion-static-swath');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const secondIndex = radar >= 0 && radar !== firstIndex ? radar : cards.findIndex((_, i) => i !== firstIndex);
  let secondName = null;
  if (secondIndex >= 0) {
    secondName = await play(secondIndex);
    const huds = await page.locator('[data-slot="replay-hud"] .ow-replay-hud').count();
    if (huds !== 1) throw new Error(`${huds} replay HUDs after replaying a second pass`);
    await page.waitForTimeout(9_500);
    await shot(radar === secondIndex ? 'second-pass-sentinel-1-right-looking' : 'second-pass-replaces-first');
    log('replaced with', secondName);
  }

  const full = sheet.locator('.ow-primary[data-action="open-full"]');
  if (!mobile && await full.count()) {
    await full.click();
    await page.waitForTimeout(2_500);
    await shot('full-view-replay-hud');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }

  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForTimeout(1_000);
  await shot('track-removed-on-close');

  const needles = pointText.match(/\d+\.\d\d/g) ?? [];
  const leaks = requests.filter(({ url, body }) => url.split('#')[0] !== startUrl.split('#')[0] && !ARCHIVE_HOSTS.includes(new URL(url).hostname)
    && needles.length > 0 && needles.every((n) => `${url} ${body}`.includes(n)));
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  return { mobile, flat, fiji, renderer, pointText, firstName, secondName, leaks: leaks.length };
}
