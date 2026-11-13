/**
 * Open the point lookup at an exact place through openOrbitalWatch, the entry
 * the map's "Satellite passes here" menu calls, then open an archive image: read the viewer, the
 * same-collection compare slider and the time-lapse, and close back to the
 * pass row. The satellite catalog comes from the orbital fixture; archive
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
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
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

  await viewer.locator('.oiv-status').waitFor({ state: 'detached', timeout: 90_000 });
  log('history', await viewer.locator('.ow-banner').innerText().catch(() => 'answered'));
  await viewer.locator('.oiv-slider, .oiv-note, .ow-banner').first().waitFor({ timeout: 60_000 });
  const slider = viewer.locator('input[type="range"]');
  if (await slider.count()) {
    await slider.fill('50');
    const sides = await viewer.locator('.oiv-slider img').evaluateAll((imgs) => imgs.map((i) => ({ src: i.src, complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, box: [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)] })));
    log('compare sides', JSON.stringify(sides));
    if (!sides.every((side) => side.complete && side.w > 0) || sides[0].box.join() !== sides[1].box.join()) throw new Error('compare sides are not both loaded at one size');
    log('compare with', await viewer.locator('.oiv-date[aria-pressed="true"]').innerText(), 'dates', await viewer.locator('.oiv-date').count());
    await viewer.locator('.oiv-compare').scrollIntoViewIfNeeded();
    await shot('compare');
  } else {
    log('compare state', await viewer.locator('.oiv-note, .oiv-error').allInnerTexts());
    await shot('compare-unavailable');
  }

  const start = viewer.locator('[data-action="timelapse-start"]');
  if (await start.count()) {
    await start.click();
    await viewer.locator('[data-timelapse="autoplay"], [data-timelapse="stepper"], [data-timelapse="insufficient"]').first().waitFor({ timeout: 90_000 });
    if (await viewer.locator('[data-action="timelapse-toggle"]').count()) {
      await page.waitForTimeout(2_000);
      await viewer.locator('[data-action="timelapse-toggle"]').click();
    }
    const frame = await viewer.locator('.oiv-timelapse-frame').evaluate((i) => ({ complete: i.complete, w: i.naturalWidth, box: [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)] })).catch(() => null);
    log('timelapse', await viewer.locator('.oiv-timelapse').innerText(), JSON.stringify(frame));
    if (frame && (!frame.complete || frame.w === 0 || frame.box[1] < 200)) throw new Error(`time-lapse frame is not shown at full size: ${JSON.stringify(frame)}`);
  } else {
    log('timelapse state', await viewer.locator('.oiv-timelapse').innerText().catch(() => 'none'));
  }
  await viewer.locator('.oiv-timelapse').scrollIntoViewIfNeeded().catch(() => {});
  await shot('timelapse');

  const offAllowlist = await page.locator('.oiv-dialog img').evaluateAll((imgs, hosts) => imgs.map((i) => i.src).filter((s) => !hosts.includes(new URL(s).hostname)), ARCHIVE_HOSTS);
  if (offAllowlist.length) throw new Error(`viewer rendered non-archive images: ${offAllowlist.join(', ')}`);

  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  if (!(await sheet.isVisible())) throw new Error('Escape closed the sheet along with the viewer');
  const focus = await page.evaluate(() => document.activeElement?.closest('.ow-row, .ow-summary, .orbital-watch-sheet')?.className ?? document.activeElement?.tagName);
  log('focus after viewer close', focus);
  if (!/ow-row|ow-best-view|orbital-watch-sheet|ow-summary/.test(String(focus))) throw new Error(`focus after viewer close went to ${focus}`);

  const needles = pointText.match(/\d+\.\d\d/g);
  const leaks = requests.filter(({ url, body }) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && needles.every((n) => `${url} ${body}`.includes(n)));
  log('requests', requests.length, 'leaks', leaks.length);
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  return { mobile, pointText, leaks: leaks.length };
}
