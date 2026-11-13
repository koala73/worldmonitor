/**
 * Satellite passes here, ground track: pick a pass in the lookup sheet and see
 * its ground track, sensor footprint and replay marker on the map.
 *
 * WM_VERIFY_ORBITAL_MAP=flat drives the flat map: deck.gl on desktop, the SVG
 * map on phones. Headless Chromium has only software GL, which MapContainer
 * refuses for deck.gl, so flat mode hides the renderer name from that check.
 * The phone SVG map has no context menu, so on phones the lookup opens from
 * the globe and the drive switches to 2D with the pass still drawn.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const flat = process.env.WM_VERIFY_ORBITAL_MAP === 'flat';
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
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

  const switchToSvg = flat && mobile;
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': flat && !mobile ? '"flat"' : '"globe"' } });
  const startUrl = `${base}/dashboard?lat=25.112&lon=55.139&zoom=${flat ? 7 : 4}`;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  const expected = flat && !mobile ? 'deckgl' : 'globe';
  if (renderer !== expected) throw new Error(`expected the ${expected} map, got ${renderer}`);

  const box = await page.locator('#mapContainer canvas').first().boundingBox();
  const dx = 0;
  const dy = 0;
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Satellite passes here' }).or(page.getByText('Satellite passes here', { exact: true })).first().click();
  const sheet = await expectVisible('.orbital-watch-sheet');
  const pointText = await sheet.locator('.ow-point').innerText();
  log('picked point', pointText);
  await sheet.locator('.ow-headline', { hasText: /Confirmed images: \d+/ }).waitFor({ timeout: 120_000 });

  const confirmed = sheet.locator('.ow-group[data-group="confirmed"] .ow-row[data-pass-key]');
  const rows = (await confirmed.count()) >= 2 ? confirmed : sheet.locator('.ow-row[data-pass-key]');
  log('selectable passes', await rows.count());
  const first = rows.first();
  const firstName = await first.locator('.ow-row-name').innerText();
  await first.click();
  await sheet.locator('.ow-row[aria-current="true"] .ow-replay').waitFor();
  log('selected', firstName, await sheet.locator('.ow-row[aria-current="true"] .ow-track-note').innerText());
  if (switchToSvg) {
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await page.waitForSelector('#mapContainer.svg-mode:not([aria-busy])', { timeout: 60_000 });
    log('renderer after switch', await waitForMap(page));
  }
  await page.waitForTimeout(3_500);
  await shot('track-replay-in-progress');
  await page.waitForTimeout(6_000);
  await shot('track-at-closest-approach');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sheet.locator('.ow-row[aria-current="true"] .ow-replay').click();
  await page.waitForTimeout(500);
  await shot('track-reduced-motion-replay');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const second = rows.nth(1);
  const secondName = await second.locator('.ow-row-name').innerText();
  await second.click();
  await sheet.locator('.ow-row[aria-current="true"] .ow-replay').waitFor();
  const selectedCount = await sheet.locator('.ow-row[aria-current="true"]').count();
  if (selectedCount !== 1) throw new Error(`${selectedCount} rows selected after choosing a second pass`);
  await page.waitForTimeout(9_500);
  await shot('second-pass-replaces-first');
  log('replaced with', secondName);

  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForTimeout(1_000);
  await shot('track-removed-on-close');

  const needles = pointText.match(/\d+\.\d\d/g);
  const leaks = requests.filter(({ url, body }) => url !== startUrl && !ARCHIVE_HOSTS.includes(new URL(url).hostname)
    && needles.every((n) => `${url} ${body}`.includes(n)));
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  return { mobile, flat, renderer, pointText, firstName, secondName, leaks: leaks.length };
}
