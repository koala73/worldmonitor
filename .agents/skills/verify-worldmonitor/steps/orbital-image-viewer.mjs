/**
 * Open the point lookup at an exact place through openOrbitalWatch, the entry
 * the map's "Satellite passes here" menu calls, then open the hero image: read
 * the viewer and the same-collection compare slider, close back to the sheet,
 * open the yearly time-lapse, and open a pass detail in the full view. The satellite catalog comes from the orbital fixture; archive
 * requests reach the real archives, so scenes vary by day.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_POINT="lat,lon" picks the place; the default is Palm
 * Jebel Ali, Dubai, where construction gives compare and time-lapse real
 * change. Palm Jumeirah (25.112,55.139) shows recognisable fronds.
 * WM_VERIFY_ORBITAL_THEME=light drives the light theme.
 */
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';
import { fixtureCatalog } from './orbital-watch.mjs';

const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int', 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'sentinel-s1-l1c.s3.amazonaws.com'];

// Scroll the pass-detail stats into view and require every row to sit clear of the pinned action bar.
async function statsClearOfActions(page) {
  const stats = await page.evaluate(() => {
    const grid = document.querySelector('.ow-detail-grid');
    grid.scrollIntoView({ block: 'end' });
    const barTop = document.querySelector('.ow-detail-actions').getBoundingClientRect().top;
    return { barTop: Math.round(barTop), cellBottoms: [...grid.querySelectorAll('.ow-detail-cell')].map((c) => Math.round(c.getBoundingClientRect().bottom)) };
  });
  if (stats.cellBottoms.some((bottom) => bottom > stats.barTop)) throw new Error(`pass-detail stats sit under the action bar: ${JSON.stringify(stats)}`);
  return stats;
}

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const [lat, lon] = (process.env.WM_VERIFY_ORBITAL_POINT ?? '25.003,54.990').split(',').map(Number);
  const catalog = fixtureCatalog();
  await page.route('**/api/orbital/v1/list-imaging-satellites*', (route) => route.fulfill({ json: catalog }));
  const requests = [];
  page.on('request', (req) => requests.push({ url: req.url(), body: req.postData() ?? '' }));

  if (process.env.WM_VERIFY_FORCE_DECK === '1') {
    // With WM_VERIFY_SOFTWARE_GL=1 on a machine with no GPU, name the software renderer as a GPU so the desktop map runs on deck.gl.
    await page.addInitScript(() => {
      for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const getParameter = proto.getParameter;
        proto.getParameter = function (name) {
          const value = getParameter.call(this, name);
          return name === 0x9246 && typeof value === 'string' ? 'ANGLE (verify GPU)' : value;
        };
      }
    });
  }
  // WM_VERIFY_ORBITAL_THEME=light drives the light theme.
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': '"flat"', 'worldmonitor-theme': theme } });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  await page.evaluate(({ lat, lon }) => import('/src/app/orbital-watch.ts').then(({ openOrbitalWatch }) => openOrbitalWatch({ lat, lon }, document.getElementById('mapContainer'))), { lat, lon });
  await expectVisible('.orbital-watch-sheet');
  const sheet = page.locator('.orbital-watch-sheet');
  const pointText = await sheet.locator('.ow-place').innerText();
  log('picked point', pointText, 'target', lat, lon);
  // Where the reticle sits once the map has stopped flying, and that it sits mid-way across the map the panels leave visible.
  const markAt = async () => {
    let prev = null;
    for (let tries = 0; tries < 60; tries++) {
      const now = await page.evaluate(() => {
        const mark = document.querySelector('.ow-mapmark');
        if (!mark || mark.hidden) return null;
        const ring = mark.querySelector('.ow-mapmark-ring').getBoundingClientRect();
        const m = document.getElementById('mapContainer').getBoundingClientRect();
        let area = { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
        const size = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
        for (const sel of ['.ow-panel', '.ow-dock', '.ow-statusbar']) {
          const c = document.querySelector(`.orbital-watch-sheet ${sel}`)?.getBoundingClientRect();
          if (!c || !c.width || !c.height || c.right <= area.left || c.left >= area.right || c.bottom <= area.top || c.top >= area.bottom) continue;
          area = [{ ...area, right: Math.min(area.right, c.left) }, { ...area, left: Math.max(area.left, c.right) },
            { ...area, bottom: Math.min(area.bottom, c.top) }, { ...area, top: Math.max(area.top, c.bottom) }]
            .reduce((best, side) => (size(side) > size(best) ? side : best));
        }
        return { x: Math.round(ring.left + ring.width / 2), y: Math.round(ring.top + ring.height / 2),
          cx: Math.round((area.left + area.right) / 2), cy: Math.round((area.top + area.bottom) / 2),
          left: Math.round(area.left), top: Math.round(area.top) };
      });
      if (now && prev && now.x === prev.x && now.y === prev.y) {
        if (Math.abs(now.x - now.cx) > 40 || Math.abs(now.y - now.cy) > 40) {
          throw new Error(`reticle at ${now.x},${now.y}, not centred in the visible map at ${now.cx},${now.cy}`);
        }
        return now;
      }
      prev = now;
      await page.waitForTimeout(250);
    }
    throw new Error(`reticle never settled on the map: ${JSON.stringify(prev)}`);
  };
  await sheet.locator('.ow-headline').waitFor({ timeout: 90_000 });
  log('headline', await sheet.locator('.ow-headline').innerText());
  const hero = sheet.locator('.ow-card').first();
  await hero.locator('.ow-tile[data-state="loaded"]').waitFor({ timeout: 90_000 });
  await sheet.locator('.ow-timelapse-entry').scrollIntoViewIfNeeded();
  log('sheet map mark', JSON.stringify(await markAt()));
  await shot('sheet');

  const trigger = hero.locator('[data-action="view-image"]');
  log('trigger', await trigger.getAttribute('aria-label'));
  await hero.locator('.ow-tile').scrollIntoViewIfNeeded();
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

  await sheet.locator('.ow-primary').click();
  await page.locator('.orbital-watch-sheet[data-view="full"]').waitFor();
  const passRow = sheet.locator('.ow-group[data-group="watched"] .ow-row[data-key^="pass:"]:has(.ow-tile img)').first();
  await passRow.waitFor({ timeout: 30_000 });
  await passRow.locator('.ow-row-name').click();
  const detail = sheet.locator('.ow-detail');
  await detail.waitFor();
  // A pass that made an image opens on its own crop, decoded, with the reticle and credit, and the crop opens the viewer.
  const crop = detail.locator('.ow-detail-media[data-media="image"] .ow-tile-hero[data-state="loaded"]');
  await crop.waitFor({ timeout: 60_000 });
  const cropInfo = await crop.evaluate((tile) => {
    const img = tile.querySelector('img');
    const box = tile.getBoundingClientRect();
    return { src: img.src, natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(box.width), Math.round(box.height)], reticle: Boolean(tile.querySelector('.ow-reticle')), credit: tile.closest('.ow-detail-media').querySelector('.ow-detail-credit')?.textContent };
  });
  log('pass detail crop', JSON.stringify(cropInfo));
  if (!ARCHIVE_HOSTS.includes(new URL(cropInfo.src).hostname) || !cropInfo.natural[0] || !cropInfo.reticle || !cropInfo.credit) throw new Error(`pass detail crop incomplete: ${JSON.stringify(cropInfo)}`);
  log('pass detail', (await detail.innerText()).replace(/\s+/g, ' '));
  log('pass detail map mark', JSON.stringify(await markAt()));
  log('pass detail stats clear of the action bar', JSON.stringify(await statsClearOfActions(page)));
  await shot('pass-detail');
  await crop.locator('[data-action="view-image"]').click();
  const cropViewer = page.locator('.oiv-dialog');
  await cropViewer.waitFor();
  const viewerSrc = await cropViewer.locator('img.oiv-image').first().getAttribute('src');
  log('pass detail crop opens the viewer on', viewerSrc === cropInfo.src ? 'the same crop' : viewerSrc);
  if (viewerSrc !== cropInfo.src) throw new Error('the pass detail crop opened the viewer on another image');
  await page.keyboard.press('Escape');
  await cropViewer.waitFor({ state: 'detached' });
  const afterViewer = await page.evaluate(() => ({ view: document.querySelector('.orbital-watch-sheet')?.dataset.view, detail: Boolean(document.querySelector('.ow-detail')), focus: document.activeElement?.className }));
  log('after closing the crop viewer', JSON.stringify(afterViewer));
  if (afterViewer.view !== 'full' || !afterViewer.detail) throw new Error(`closing the crop viewer also closed the pass detail: ${JSON.stringify(afterViewer)}`);
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'detached' });
  if (!(await page.evaluate(() => document.body.classList.contains('live-news-fullscreen-active')))) {
    throw new Error('Escape from the pass detail lowered the raised map under the full view');
  }

  // A pass with no image of the spot shows its tier glyph and label instead of a blank box.
  const bare = sheet.locator('.ow-row[data-key^="pass:"]:has(.ow-glyph-tile)').first();
  if (await bare.count()) {
    await bare.scrollIntoViewIfNeeded();
    await bare.locator('.ow-row-name').click();
    await detail.waitFor();
    const glyph = await detail.locator('.ow-detail-media[data-media="glyph"]').innerText();
    log('pass detail without an image', glyph.replace(/\s+/g, ' '));
    log('pass detail stats clear of the action bar', JSON.stringify(await statsClearOfActions(page)));
    await shot('pass-detail-glyph');
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'detached' });
  } else log('pass detail without an image', 'no imageless pass in this lookup');
  if (!(await page.locator('.orbital-watch-sheet[data-view="full"]').count())) throw new Error('Escape from the pass detail left the full view');

  const needles = pointText.match(/\d+\.\d\d/g);
  const leaks = requests.filter(({ url, body }) => !ARCHIVE_HOSTS.includes(new URL(url).hostname) && needles.every((n) => `${url} ${body}`.includes(n)));
  log('requests', requests.length, 'leaks', leaks.length);
  if (leaks.length) throw new Error(`picked point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  // RUM collectors name a resource by host and its last path segment, so the point may not end any path.
  const pathLeaks = requests.filter(({ url }) => needles.some((n) => new URL(url).pathname.split('/').pop().includes(n)));
  log('requests ending their path with the point', pathLeaks.length);
  if (pathLeaks.length) throw new Error(`picked point ends a URL path: ${pathLeaks.map((l) => l.url).join(', ')}`);
  return { mobile, pointText, leaks: leaks.length };
}
