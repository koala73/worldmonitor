/**
 * Open the point lookup at an exact place through openOrbitalWatch, the entry
 * the map's "Satellite passes here" menu calls, then open an archive image: read the viewer and the
 * same-collection compare slider, close back to the pass row, and open the
 * yearly time-lapse from the sheet. The satellite catalog comes from the orbital fixture; archive
 * requests reach the real archives, so scenes vary by day.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_POINT="lat,lon" picks the place; the default is Palm
 * Jebel Ali, Dubai, where construction gives compare and time-lapse real
 * change. Palm Jumeirah (25.112,55.139) shows recognisable fronds.
 */
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';
import { fixtureCatalog } from './orbital-watch.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int', 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'sentinel-s1-l1c.s3.amazonaws.com'];

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const [lat, lon] = (process.env.WM_VERIFY_ORBITAL_POINT ?? '25.003,54.990').split(',').map(Number);
  const catalog = fixtureCatalog();
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: catalog }));
  const requests = [];
  page.on('request', (req) => requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  await page.evaluate(({ lat, lon }) => import('/src/app/orbital-watch.ts').then(({ openOrbitalWatch }) => openOrbitalWatch({ lat, lon }, document.getElementById('mapContainer'))), { lat, lon });
  await expectVisible('.orbital-watch-sheet');
  const sheet = page.locator('.orbital-watch-sheet');
  const pointText = await sheet.locator('.ow-point').innerText();
  log('picked point', pointText, 'target', lat, lon);
  await sheet.locator('.ow-headline', { hasText: /Confirmed images: \d+/ }).waitFor({ timeout: 90_000 });

  const trigger = sheet.locator('.ow-best-view').or(sheet.locator('.ow-view-image[data-image-kind="acquisition"]')).first();
  await trigger.waitFor({ timeout: 30_000 });
  log('trigger', await trigger.getAttribute('class'), await trigger.innerText().catch(() => ''));
  await trigger.click();
  const viewer = page.locator('.oiv-dialog');
  await expectVisible('.oiv-dialog');
  await viewer.locator('img.oiv-image').first().evaluate((img) => img.complete || new Promise((r) => { img.onload = img.onerror = r; }));
  log('image', await viewer.locator('img.oiv-image').first().getAttribute('src'));
  log('credit', await viewer.locator('.oiv-credit').allInnerTexts());
  log('orientation', await viewer.locator('.oiv-north, .oiv-orientation').first().getAttribute('aria-label').catch(() => 'none'));
  await shot('viewer');

  const changeTab = viewer.locator('[data-action="mode"][data-mode="change"]');
  if (await changeTab.count()) {
    await changeTab.click();
    await viewer.locator('.oiv-slider, .oiv-compare .oiv-stage-empty').first().waitFor({ timeout: 90_000 });
    log('history', await viewer.locator('.oiv-note').allInnerTexts());
  }
  const slider = viewer.locator('input[type="range"]');
  if (await slider.count()) {
    await slider.fill('50');
    const sides = await viewer.locator('.oiv-slider img').evaluateAll((imgs) => imgs.map((i) => ({ src: i.src, complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, box: [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)] })));
    log('compare sides', JSON.stringify(sides));
    if (!sides.every((side) => side.complete && side.w > 0) || sides[0].box.join() !== sides[1].box.join()) throw new Error('compare sides are not both loaded at one size');
    log('compare chips', await viewer.locator('.oiv-chip').allInnerTexts(), 'dates', await viewer.locator('.oiv-date').count(), 'cloudy toggle', await viewer.locator('[data-action="show-cloudy"]').innerText().catch(() => 'none'));
    await shot('compare');
  } else {
    log('compare state', await viewer.locator('.oiv-compare').innerText().catch(() => 'no change tab'));
    await shot('compare-unavailable');
  }
  const offAllowlist = await page.locator('.oiv-dialog img').evaluateAll((imgs, hosts) => imgs.map((i) => i.src).filter((s) => !hosts.includes(new URL(s).hostname)), ARCHIVE_HOSTS);
  if (offAllowlist.length) throw new Error(`viewer rendered non-archive images: ${offAllowlist.join(', ')}`);

  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  if (!(await sheet.isVisible())) throw new Error('Escape closed the sheet along with the viewer');
  const focus = await page.evaluate(() => document.activeElement?.closest('.ow-row, .ow-summary, .orbital-watch-sheet')?.className ?? document.activeElement?.tagName);
  log('focus after viewer close', focus);
  if (!/ow-row|ow-best-view|orbital-watch-sheet|ow-summary/.test(String(focus))) throw new Error(`focus after viewer close went to ${focus}`);

  await sheet.locator('.ow-timelapse-entry').click();
  const timelapse = page.locator('.otl-page');
  await timelapse.locator('[data-timelapse]').first().waitFor({ timeout: 120_000 });
  if (await timelapse.locator('[data-action="toggle"]').count()) {
    await page.waitForTimeout(Number(process.env.WM_VERIFY_ORBITAL_PLAY_MS ?? 2_500));
    await timelapse.locator('[data-action="toggle"]').click();
  }
  await timelapse.locator('img.oiv-image').evaluate((img) => img.complete || new Promise((r) => { img.onload = img.onerror = r; })).catch(() => {});
  const frame = await timelapse.locator('img.oiv-image').evaluate((i) => ({ src: i.src, complete: i.complete, w: i.naturalWidth, box: [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)] })).catch(() => null);
  log('timelapse', await timelapse.locator('.oiv-counter, .otl-year-detail, .otl-total').allInnerTexts(), 'years', await timelapse.locator('.otl-row-year').allInnerTexts(), JSON.stringify(frame));
  if (frame && (!frame.complete || frame.w === 0 || frame.box[0] !== frame.box[1] || frame.box[1] < 300)) throw new Error(`time-lapse frame is not a full square: ${JSON.stringify(frame)}`);
  const offAllowlistFrames = await timelapse.locator('img').evaluateAll((imgs, hosts) => imgs.map((i) => i.src).filter((s) => !hosts.includes(new URL(s).hostname)), ARCHIVE_HOSTS);
  if (offAllowlistFrames.length) throw new Error(`time-lapse rendered non-archive images: ${offAllowlistFrames.join(', ')}`);
  await shot('timelapse');
  await page.keyboard.press('Escape');
  await timelapse.waitFor({ state: 'detached' });

  const needles = pointText.match(/\d+\.\d\d/g);
  const leaks = requests.filter(({ url, body }) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && needles.every((n) => `${url} ${body}`.includes(n)));
  log('requests', requests.length, 'leaks', leaks.length);
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  return { mobile, pointText, leaks: leaks.length };
}
