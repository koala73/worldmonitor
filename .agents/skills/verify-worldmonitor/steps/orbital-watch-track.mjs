/**
 * Satellite passes here, ground track: pick a pass in the evidence sheet and see
 * its ground track, sensor footprint and the satellite at closest approach on the map.
 *
 * WM_VERIFY_ORBITAL_MAP=flat drives the flat map: deck.gl on desktop, the SVG
 * map on phones. Headless Chromium has only software GL, which MapContainer
 * refuses for deck.gl, so flat mode hides the renderer name from that check.
 * The lookup opens from its shared link, #orbital=<lat>,<lon>, so the pin sits
 * on the exact point on every renderer.
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_POINT=fiji looks up a point by the antimeridian instead of Palm Jumeirah.
 * WM_VERIFY_ORBITAL_THEME=light drives the light theme.
 */
import { fixtureCatalog } from './orbital-watch.mjs';
import { pointFromText, pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';

export default async function ({ page, base, shot: capture, log, expectVisible }) {
  const shot = async (name) => {
    await page.evaluate(() => document.querySelector('.imagery-evidence-sheet .ies-body')?.scrollTo(0, 0));
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
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': flat ? '"flat"' : '"globe"', 'worldmonitor-theme': theme } });
  const startUrl = `${base}/dashboard?lat=${at.lat}&lon=${at.lon}&zoom=${flat ? 7 : 4}&layers=none#orbital=${at.lat},${at.lon}`;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  const renderer = await waitForMap(page);
  log('renderer', renderer);
  const expected = flat ? (mobile ? 'svg' : 'deckgl') : 'globe';
  if (renderer !== expected) throw new Error(`expected the ${expected} map, got ${renderer}`);
  const sheet = await expectVisible('.imagery-evidence-sheet');
  const collapse = page.locator('#mapContainer .toggle-collapse:visible').first();
  if (await collapse.count()) await collapse.click().catch(() => {});
  const pointText = `${await sheet.locator('.ies-place').innerText()} ${await sheet.locator('.ies-coords').innerText()}`.trim();
  log('picked point', pointText);
  await page.waitForFunction(() => document.querySelector('.imagery-evidence-sheet')?.dataset.state === 'answered', null, { timeout: 120_000 });
  const rows = sheet.locator('.ies-row[data-key^="pass:"]:visible');
  const passes = await rows.evaluateAll((els) => els.map((el) => ({
    key: el.dataset.key, tier: el.dataset.tier, name: el.querySelector('.ies-name')?.textContent?.trim() ?? '',
  })));
  log('pass rows', JSON.stringify(passes));
  if (passes.length === 0) throw new Error('the answered sheet lists no passes');
  const radar = passes.findIndex((pass) => /sentinel-1/i.test(pass.name));
  const optical = passes.findIndex((pass) => /sentinel-2|landsat/i.test(pass.name));
  const firstIndex = optical >= 0 ? optical : 0;
  // Live breaking-news alerts push the phone map strip down; dismiss them as a reader would.
  const dismissAlerts = () => page.evaluate(() => {
    for (const button of document.querySelectorAll('.breaking-alert-dismiss')) button.click();
  });
  // The sheet docks over the map and restyles the chosen row, so it is hidden while the map is captured.
  const mapPixels = async () => {
    const hideSheet = (hidden) => page.evaluate((hidden) => {
      const el = document.querySelector('.imagery-evidence-sheet');
      if (el) el.style.visibility = hidden ? 'hidden' : '';
    }, hidden);
    await hideSheet(true);
    try {
      return await page.screenshot({ clip: await page.locator('#mapContainer').boundingBox() });
    } finally {
      await hideSheet(false);
    }
  };
  // Pixels that differ between two map captures; the globe keeps repainting a little on its own.
  const changedPixels = (one, two) => page.evaluate(async ([one, two]) => {
    const decode = async (png) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [x, y] = await Promise.all([decode(one), decode(two)]);
    if (x.length !== y.length) return x.length / 4;
    let n = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 48) n++;
    }
    return n;
  }, [one.toString('base64'), two.toString('base64')]);
  // The SVG map draws the track as DOM; deck.gl and the globe draw it on a canvas, so there the map must repaint.
  const svgTracks = () => page.locator('#mapContainer .orbital-track').count();
  const svgGroundTrack = () => page.locator('#mapContainer .orbital-track').first()
    .evaluate((layer) => [...layer.querySelectorAll('path:not([class])')].map((path) => path.getAttribute('d')).join('|'));
  let drawn = null;
  const select = async (index) => {
    await dismissAlerts();
    const row = sheet.locator(`.ies-row[data-key="${passes[index].key}"]:visible`).first();
    let before = null;
    let noise = 0;
    if (renderer !== 'svg') {
      const first = await mapPixels();
      await page.waitForTimeout(1_000);
      before = await mapPixels();
      noise = await changedPixels(first, before);
    }
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.waitForFunction((key) => {
      const current = [...document.querySelectorAll('.imagery-evidence-sheet .ies-row[aria-current="true"]')];
      // A pass can be listed twice (its group and the latest section); every current row must be that pass.
      return current.length > 0 && current.every((row) => row.dataset.key === key);
    }, passes[index].key, { timeout: 10_000 });
    if (renderer === 'svg') {
      await page.locator('#mapContainer.orbital-tracked .orbital-track').first().waitFor({ timeout: 15_000 });
      await page.waitForFunction((previous) => {
        const layer = document.querySelector('#mapContainer .orbital-track');
        const shape = layer && [...layer.querySelectorAll('path:not([class])')].map((path) => path.getAttribute('d')).join('|');
        return !!shape && shape !== previous;
      }, drawn, { timeout: 15_000 });
      const tracks = await svgTracks();
      if (tracks !== 1) throw new Error(`${tracks} drawn tracks after selecting ${passes[index].name}`);
      drawn = await svgGroundTrack();
    } else {
      // The selected pass's footprint and track must repaint well beyond the map's own idle flicker.
      const needed = Math.max(4 * noise, 150);
      let changed = 0;
      for (let tries = 0; tries < 30 && changed < needed; tries++) {
        await page.waitForTimeout(500);
        changed = await changedPixels(before, await mapPixels());
      }
      log('map repaint', JSON.stringify({ pass: passes[index].name, noise, changed, needed }));
      if (changed < needed) throw new Error(`the map did not draw ${passes[index].name}: ${changed} pixels changed, needed ${needed}`);
    }
    await page.waitForTimeout(2_500);
    return passes[index].name;
  };
  const firstName = await select(firstIndex);
  log('selected', firstName);
  await shot('pass-track-and-footprint');

  const firstKey = passes[firstIndex].key;
  const secondIndex = radar >= 0 && passes[radar].key !== firstKey ? radar : passes.findIndex((pass) => pass.key !== firstKey);
  let secondName = null;
  if (secondIndex >= 0) {
    secondName = await select(secondIndex);
    await shot(radar === secondIndex ? 'second-pass-sentinel-1-right-looking' : 'second-pass-replaces-first');
    log('replaced with', secondName);
  }

  await sheet.locator('[data-action="close"]').click();
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForTimeout(1_000);
  if (renderer === 'svg' && await svgTracks()) throw new Error('the track stayed on the map after the sheet closed');
  await shot('track-removed-on-close');

  const picked = pointFromText(pointText);
  const leaks = requests.filter(({ url, body }) => url.split('#')[0] !== startUrl.split('#')[0] && !ARCHIVE_HOSTS.includes(new URL(url).hostname)
    && pointLeak(`${url} ${body}`, picked));
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  return { mobile, flat, fiji, renderer, pointText, firstName, secondName, leaks: leaks.length };
}
