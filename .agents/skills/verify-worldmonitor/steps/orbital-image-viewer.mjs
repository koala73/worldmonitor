/**
 * Satellite passes here, then open an archive image: read the viewer, the
 * same-collection compare slider and the time-lapse, and close back to the
 * pass row. Archive requests reach the real archives, so scenes vary by day.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 */
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int', 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'sentinel-s1-l1c.s3.amazonaws.com'];

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  page.on('request', (req) => requests.push({ url: req.url(), body: req.postData() ?? '' }));

  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"globe"' } });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  const box = await page.locator('#mapContainer canvas').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Satellite passes here' }).or(page.getByText('Satellite passes here', { exact: true })).first().click();
  await expectVisible('.orbital-watch-sheet');
  const sheet = page.locator('.orbital-watch-sheet');
  const pointText = await sheet.locator('.ow-point').innerText();
  log('picked point', pointText);
  await sheet.locator('.ow-headline', { hasText: /Confirmed images: \d+/ }).waitFor({ timeout: 90_000 });

  const trigger = sheet.locator('.ow-best-view').or(sheet.locator('.ow-view-image[data-image-kind="acquisition"]')).first();
  await trigger.waitFor({ timeout: 30_000 });
  log('trigger', await trigger.getAttribute('class'), await trigger.innerText().catch(() => ''));
  await trigger.click();
  const viewer = page.locator('.oiv-dialog');
  await expectVisible('.oiv-dialog');
  await viewer.locator('img.oiv-image').first().evaluate((img) => img.complete || new Promise((r) => { img.onload = img.onerror = r; }));
  log('credit', await viewer.locator('.oiv-credit').allInnerTexts());
  log('orientation', await viewer.locator('.oiv-north, .oiv-orientation').first().getAttribute('aria-label').catch(() => 'none'));
  await shot('viewer');

  await viewer.locator('.oiv-slider, .oiv-compare, .oiv-note, .ow-banner').first().waitFor({ timeout: 60_000 });
  const slider = viewer.locator('input[type="range"]');
  if (await slider.count()) {
    await slider.fill('30');
    await viewer.locator('.oiv-before').evaluate((img) => img.complete || new Promise((r) => { img.onload = img.onerror = r; }));
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
    log('timelapse', await viewer.locator('.oiv-timelapse').innerText());
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
