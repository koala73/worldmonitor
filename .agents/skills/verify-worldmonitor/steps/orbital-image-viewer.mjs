/**
 * Orbital image viewer: open the latest image from the imagery evidence sheet,
 * check both layouts, prove every image is painted from a blob:, and prove
 * Compare searches the mission's history and loads a pair from it.
 *
 * WM_VERIFY_ORBITAL_VIEWPORT=mobile drives a phone-sized viewport.
 * WM_VERIFY_ORBITAL_POINT="lat,lon" picks the place (two decimals, as a share link
 * keeps); the default is Palm Jumeirah, Dubai, where clear Sentinel-2 scenes are
 * common. WM_VERIFY_ORBITAL_THEME=light drives the light theme.
 */
import { archiveUrlAfterScrub, pointFromText, pointLeak } from './_point-leak.mjs';
import { seedProfile, waitForBoot, waitForMap } from './_profile.mjs';
import { fixtureCatalog } from './orbital-watch.mjs';

const POINT_IMAGE_HOSTS = ['planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int'];
const ARCHIVE_HOSTS = ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com', 'gibs.earthdata.nasa.gov', 'view.eumetsat.int', 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'sentinel-s1-l1c.s3.amazonaws.com'];
const CATALOG_PATH = '/api/orbital/v1/list-imaging-satellites';
const VENDOR_URL = /sentry|umami|\/_vercel\/insights|debugbear|dbbrum/i;
const SHEET = '.imagery-evidence-sheet';
const START = { lat: -15, lon: 80, zoom: 4 };
const isSearch = (url) => ['earth-search.aws.element84.com', 'planetarycomputer.microsoft.com'].includes(new URL(url).hostname) && new URL(url).pathname.endsWith('/search');
// Sheet and viewer srcs that are neither a blob: nor a scene-wide archive preview: a point-bearing or off-allowlist URL.
// Resolved against the page, so a relative or protocol-relative src is checked by the host it loads from.
const unsafeSrcs = (srcs, base) => srcs.map((src) => new URL(src, base)).filter((url) => /^https?:$/.test(url.protocol)
  && (POINT_IMAGE_HOSTS.includes(url.hostname) || !ARCHIVE_HOSTS.includes(url.hostname))).map(String);

export default async function ({ page, base, shot, log, expectVisible }) {
  const mobile = process.env.WM_VERIFY_ORBITAL_VIEWPORT === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await page.setViewportSize(viewport);
  const [lat, lon] = (process.env.WM_VERIFY_ORBITAL_POINT || '25.11,55.14').split(',').map(Number);
  await page.route(`**${CATALOG_PATH}*`, (route) => route.fulfill({ json: fixtureCatalog() }));

  const requests = [];
  page.on('request', (req) => requests.push({
    url: req.url(), body: req.postData() ?? '', harnessNavigation: req.isNavigationRequest() && req.frame() === page.mainFrame(),
  }));
  const lcpUrls = [];
  const imgSrcs = [];
  await page.exposeFunction('__wmRecordLcp', (url) => { lcpUrls.push(url); });
  await page.exposeFunction('__wmRecordSrc', (src) => { imgSrcs.push(src); });
  await page.addInitScript(() => {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__wmRecordLcp(entry.url); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes].flatMap((n) => (n.nodeType === 1 ? [n, ...n.querySelectorAll('img')] : []));
        for (const node of nodes) if (node.tagName === 'IMG' && node.getAttribute('src') && node.closest('.imagery-evidence-sheet, .oiv-dialog')) window.__wmRecordSrc(node.getAttribute('src'));
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    // MapContainer refuses deck.gl on a software GL renderer, and this VM only has SwiftShader.
    const UNMASKED_RENDERER = 0x9246;
    const original = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter) {
      return parameter === UNMASKED_RENDERER ? 'verify renderer' : original.call(this, parameter);
    };
  });
  const theme = process.env.WM_VERIFY_ORBITAL_THEME === 'light' ? 'light' : 'dark';
  await seedProfile(page, { localStorage: { 'worldmonitor-map-mode': JSON.stringify('flat'), 'worldmonitor-theme': theme } });
  await page.goto(`${base}/dashboard?view=global&layers=none&lat=${START.lat}&lon=${START.lon}&zoom=${START.zoom}`, { waitUntil: 'domcontentloaded' });
  await waitForBoot(page, { data: true });
  log('renderer', await waitForMap(page));

  // The two-decimal route is what a shared lookup opens, and it is the only way in on the SVG map.
  await page.evaluate(({ lat, lon }) => { location.hash = `orbital=${lat.toFixed(2)},${lon.toFixed(2)}`; }, { lat, lon });
  await expectVisible(SHEET);
  const sheet = page.locator(SHEET);
  await page.locator(`${SHEET}[data-state="answered"]`).waitFor({ timeout: 120_000 });
  const point = pointFromText(`${await sheet.locator('.ies-place').innerText()} ${await sheet.locator('.ies-coords').innerText()}`);
  log('point', JSON.stringify(point), 'evidence', await sheet.locator('.ies-evidence-line').innerText());
  if (!point) throw new Error('the sheet shows no coordinates');

  const latest = sheet.locator('[data-section="latest"]');
  const heroTile = latest.locator('.ow-tile-hero[data-state="loaded"]');
  await heroTile.locator('img[src^="blob:"]').waitFor({ timeout: 90_000 });
  await heroTile.scrollIntoViewIfNeeded();
  // The sheet stays inside the viewport, a phone sheet spans its width, and the hero stays square inside the sheet.
  const sheetLayout = await page.evaluate(() => {
    const panel = document.querySelector('.imagery-evidence-sheet .ies-panel').getBoundingClientRect();
    const hero = document.querySelector('.imagery-evidence-sheet [data-section="latest"] .ow-tile-hero').getBoundingClientRect();
    const r = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
    return { panel: r(panel), hero: r(hero), vw: innerWidth, vh: innerHeight };
  });
  log('sheet layout', JSON.stringify(sheetLayout));
  const { panel, hero, vw, vh } = sheetLayout;
  if (panel.x < 0 || panel.x + panel.w > vw + 1 || panel.y + panel.h > vh + 1) throw new Error('the sheet runs off the viewport');
  if (mobile && Math.abs(panel.w - vw) > 1) throw new Error(`the phone sheet is ${panel.w}px wide in a ${vw}px viewport`);
  if (Math.abs(hero.w - hero.h) > 2) throw new Error(`the latest image is not square: ${hero.w}x${hero.h}`);
  if (hero.x < panel.x || hero.x + hero.w > panel.x + panel.w + 1) throw new Error('the latest image overflows the sheet');
  if (hero.w < panel.w * 0.6) throw new Error(`the latest image is a thumbnail in the sheet: ${hero.w}px of ${panel.w}px`);
  await shot('sheet-latest-image');

  // Open the image.
  const openedAt = requests.length;
  const trigger = latest.locator('[data-action="view-image"]').first();
  await trigger.click();
  const viewer = page.locator('.oiv-dialog');
  await viewer.waitFor();
  const image = viewer.locator('.oiv-stage img.oiv-image');
  await image.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => { const img = document.querySelector('.oiv-dialog .oiv-stage img.oiv-image'); return img?.complete && img.naturalWidth > 0; }, null, { timeout: 30_000 });
  const viewed = await page.evaluate(() => {
    const dialog = document.querySelector('.oiv-dialog').getBoundingClientRect();
    const img = document.querySelector('.oiv-dialog .oiv-stage img.oiv-image');
    const box = img.getBoundingClientRect();
    const north = document.querySelector('.oiv-dialog .oiv-north');
    return {
      blob: img.getAttribute('src').startsWith('blob:'), natural: [img.naturalWidth, img.naturalHeight],
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      dialog: [Math.round(dialog.width), Math.round(dialog.height)],
      credit: document.querySelector('.oiv-dialog .oiv-credit')?.textContent.trim() ?? '',
      north: !!north && north.getBoundingClientRect().width > 0,
      tabs: [...document.querySelectorAll('.oiv-dialog [data-action="mode"]')].map((b) => `${b.dataset.mode}${b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
      focusInside: document.querySelector('.oiv-dialog').contains(document.activeElement),
    };
  });
  log('viewer', JSON.stringify(viewed));
  if (!viewed.blob) throw new Error('the viewer image is not painted from a blob:');
  if (!viewed.credit) throw new Error('the viewer shows no credit');
  if (!viewed.north) throw new Error('the viewer shows no north arrow');
  if (!viewed.focusInside) throw new Error('focus did not move into the viewer');
  const [x, y, w, h] = viewed.box;
  if (x < 0 || y < 0 || x + w > vw + 1 || y + h > vh + 1) throw new Error(`the viewer image runs off the viewport: ${viewed.box}`);
  const naturalRatio = viewed.natural[0] / viewed.natural[1];
  if (Math.abs(w / h - naturalRatio) > 0.05) throw new Error(`the viewer image is stretched: ${w}x${h} for ${viewed.natural.join('x')}`);
  if (Math.min(w, h) < Math.min(vw, vh) * (mobile ? 0.8 : 0.5)) throw new Error(`the viewer image is small for the viewport: ${w}x${h}`);
  if (!viewed.tabs.some((tab) => tab.startsWith('change'))) throw new Error(`the viewer has no Change mode: ${viewed.tabs}`);
  await shot('viewer-image');

  // Compare: the change mode searches the mission's history and slides between two blob: images.
  await viewer.locator('[data-action="mode"][data-mode="change"]').click();
  await page.waitForFunction(() => {
    const stage = document.querySelector('.oiv-dialog .oiv-compare .oiv-stage');
    if (!stage || stage.classList.contains('oiv-skeleton')) return false;
    // A found pair must also have decoded both images; a stage without a slider is the no-pair state.
    const images = [...document.querySelectorAll('.oiv-dialog .oiv-slider img.oiv-image')];
    return !document.querySelector('.oiv-dialog .oiv-slider') || (images.length === 2 && images.every((img) => img.complete && img.naturalWidth > 0));
  }, null, { timeout: 120_000 });
  const searches = requests.slice(openedAt).filter(({ url }) => isSearch(url));
  log('history searches since the viewer opened', searches.length, [...new Set(searches.map(({ url }) => new URL(url).host))]);
  const slider = viewer.locator('.oiv-slider');
  if (!(await slider.count())) throw new Error(`Compare found no pair: ${await viewer.locator('.oiv-compare').innerText()}`);
  if (!searches.length) throw new Error('Compare paired images without searching the history');
  const pair = await page.evaluate(() => [...document.querySelectorAll('.oiv-dialog .oiv-slider img.oiv-image')].map((img) => {
    const b = img.getBoundingClientRect();
    return { blob: img.getAttribute('src').startsWith('blob:'), painted: img.complete && img.naturalWidth > 0, box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] };
  }));
  const chips = await viewer.locator('.oiv-slider .oiv-chip').allInnerTexts();
  log('compare pair', JSON.stringify(pair), 'chips', chips, 'dates', (await viewer.locator('.oiv-date').allInnerTexts()).length);
  if (pair.length !== 2 || pair.some((p) => !p.blob || !p.painted)) throw new Error('the compare pair is not two painted blob: images');
  if (pair[0].box.join() !== pair[1].box.join()) throw new Error('the compare images are not stacked on the same box');
  if (chips.length !== 2 || chips[0] === chips[1]) throw new Error(`the compare chips do not name two dates: ${chips}`);
  const divider = viewer.locator('input.oiv-divider');
  await divider.fill('30');
  const at = await slider.evaluate((el) => el.style.getPropertyValue('--oiv-divider'));
  log('divider at', at);
  if (at.trim() !== '30%') throw new Error(`the divider did not move: ${at}`);
  await shot('viewer-compare');

  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  await expectVisible(SHEET);
  const refocused = await trigger.evaluate((el) => el === document.activeElement);
  log('focus back on the image after closing', refocused);
  if (!refocused) throw new Error('closing the viewer did not return focus to the image');

  // The sheet's "Compare with" opens the viewer straight on the pair.
  const compareButton = latest.locator('[data-action="compare"]');
  if (await compareButton.count()) {
    await compareButton.click();
    await viewer.locator('.oiv-slider img.oiv-image').nth(1).waitFor({ timeout: 90_000 });
    log('sheet compare opened the pair', await viewer.locator('.oiv-slider .oiv-chip').allInnerTexts());
    await shot('sheet-compare');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
  } else {
    log('sheet compare', 'no earlier clear scene of this mission on the sheet');
  }

  const leaking = (text) => pointLeak(text, point);
  const leaks = requests.filter(({ url, body, harnessNavigation }) => !harnessNavigation && !ARCHIVE_HOSTS.includes(new URL(url).hostname) && leaking(`${url} ${body}`));
  log('requests', requests.length, 'archive', requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname)).length, 'leaking the point', leaks.length);
  if (leaks.length) throw new Error(`the point left the browser: ${leaks.map((l) => l.url).join(', ')}`);
  const pathLeaks = requests.filter(({ url }) => ARCHIVE_HOSTS.includes(new URL(url).hostname) && leaking(archiveUrlAfterScrub(url)));
  if (pathLeaks.length) throw new Error(`the point survives the telemetry scrub: ${pathLeaks.map((l) => l.url).join(', ')}`);
  const vendorLeaks = requests.filter(({ url, body }) => VENDOR_URL.test(url) && leaking(`${url} ${body}`));
  if (vendorLeaks.length) throw new Error(`the point in a telemetry payload: ${vendorLeaks.map((l) => l.url).join(', ')}`);
  const direct = unsafeSrcs(imgSrcs, base);
  log('img srcs', imgSrcs.length, 'blob:', imgSrcs.filter((s) => s.startsWith('blob:')).length, 'point-bearing or off-allowlist srcs', direct.length);
  if (direct.length) throw new Error(`a point-bearing archive URL in an img src: ${direct.join(', ')}`);
  const lcpArchive = lcpUrls.filter((url) => url && !url.startsWith('blob:') && ARCHIVE_HOSTS.includes(new URL(url).hostname));
  if (lcpArchive.length) throw new Error(`an archive URL became the LCP element: ${lcpArchive.join(', ')}`);
  return { mobile, point, pair: chips, historySearches: searches.length, leaks: leaks.length };
}
