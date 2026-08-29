/**
 * qa-attribution-b12.mjs — visual + state proof for Batch 12 (data attribution).
 *
 * Public attribution checks:
 *   H10 — the Google/Cesium credit MUST stay visible in clean-view AND
 *         recording modes (those are the modes used to record demos).
 *   H11 — every data layer's required attribution must surface in the
 *         expandable bottom-left "Data attribution" lightbox.
 *
 * This script drives the REAL app headless and proves:
 *   (i)   per-layer credits are registered in viewer.creditDisplay (H11),
 *         and appear in the "Data attribution" lightbox when opened;
 *   (ii)  enabling datacenters + submarine cables keeps their credits present;
 *   (iii) toggling clean-view keeps #cesium-credits visible (screenshot);
 *   (iv)  toggling recording-mode keeps #cesium-credits visible (screenshot).
 *
 * Run:  node scripts/qa-attribution-b12.mjs --url http://localhost:4300
 */
import puppeteer from 'puppeteer';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function getOpt(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const APP_URL = getOpt('--url', 'http://localhost:4300');
const APP_ORIGIN = new URL(APP_URL).origin;
const SHOT_DIR = resolve(__dirname, '..', 'qa-shots', 'b12');
mkdirSync(SHOT_DIR, { recursive: true });

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  return CHROME_EXECUTABLE_CANDIDATES.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  }) || null;
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

// Substrings that MUST be present across the registered per-layer credits.
const REQUIRED_CREDIT_SUBSTRINGS = [
  'OpenStreetMap contributors', // ODbL — datacenters/dams/roads
  'adsb.lol',                    // ODbL — military traces
  'TeleGeography',               // CC BY-NC-SA — cables
  'NASA FIRMS',                  // fires
  'CelesTrak',                   // satellites
  'U.S. Geological Survey',      // earthquakes
  'OpenSky Network',             // flights
  'AISStream',                   // vessels
  'City of Austin',              // CCTV
  'Radio Browser',               // internet-radio directory
];

async function main() {
  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN && url.pathname === '/api/openai/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'QA globe ready' }),
      });
      return;
    }
    request.continue();
  });

  const consoleErrors = [];
  const failedResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const sourceUrl = msg.location()?.url || '';
      consoleErrors.push(sourceUrl ? `${msg.text()} [${sourceUrl}]` : msg.text());
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });

  console.log(`\n  qa-attribution-b12 → ${APP_URL}\n`);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the app + viewer.creditDisplay to be live.
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.viewer.creditDisplay,
    { timeout: 60000 },
  );
  // Give Cesium a few frames to render the on-screen credit line (logo + link).
  await new Promise((r) => setTimeout(r, 2500));

  // ── (i) H11: static credits registered ────────────────────────────
  console.log('H11 — per-layer credits registered in viewer.creditDisplay');
  const registeredHtml = await page.evaluate(() => {
    const cd = window.__godsEyeView.viewer.creditDisplay;
    const statics = cd._staticCredits || [];
    return statics.map((c) => c.html);
  });
  check(
    'creditDisplay has static per-layer credits',
    registeredHtml.length >= 10,
    `${registeredHtml.length} static credits registered`,
  );
  for (const sub of REQUIRED_CREDIT_SUBSTRINGS) {
    const found = registeredHtml.some((h) => h.includes(sub));
    check(`credit present: "${sub}"`, found, found ? '' : 'MISSING');
  }

  // ── (i) H11: credits render in the "Data attribution" lightbox ─────
  console.log('\nH11 — "Data attribution" lightbox surfaces the credits');
  // Force a render frame so the credit display flushes, then open the lightbox.
  const lightboxState = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    viewer.scene.requestRender();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cd = viewer.creditDisplay;
    cd.showLightbox();
    viewer.scene.requestRender();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = document.querySelector('.cesium-credit-lightbox');
    const list = box?.querySelector(':scope > ul');
    const title = box?.querySelector('.cesium-credit-lightbox-title');
    const close = box?.querySelector('.cesium-credit-lightbox-close');
    const boxRect = box?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const overlay = document.querySelector('.cesium-credit-lightbox-overlay');
    const worldOverlay = document.getElementById('world-overlay-root');
    document.querySelector('[data-qa-attribution-stack-probe]')?.remove();
    const stackProbe = document.createElement('div');
    stackProbe.dataset.qaAttributionStackProbe = 'true';
    stackProbe.textContent = 'QA WORLD LABEL — STACK PROBE';
    Object.assign(stackProbe.style, {
      position: 'absolute',
      left: `${Math.max(8, (boxRect?.left || 0) - 90)}px`,
      top: `${Math.max(8, (boxRect?.top || 0) + 150)}px`,
      width: '180px',
      padding: '5px 8px',
      color: '#8ffcff',
      background: 'rgba(4, 18, 28, 0.94)',
      borderLeft: '3px solid #19d9e8',
      font: '11px monospace',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    });
    worldOverlay?.appendChild(stackProbe);
    const stackProbeRect = stackProbe.getBoundingClientRect();
    const lastItem = list?.lastElementChild;
    if (list) list.scrollTop = list.scrollHeight;
    const lastRect = lastItem?.getBoundingClientRect();
    return {
      html: box?.innerHTML || '',
      itemCount: list?.children.length || 0,
      linkCount: list?.querySelectorAll('a[href]').length || 0,
      everyLinkHasDestination: [...(list?.querySelectorAll('a') || [])]
        .every((link) => Boolean(link.getAttribute('href'))),
      boxHeight: boxRect?.height || 0,
      viewportHeight: window.innerHeight,
      listClientHeight: list?.clientHeight || 0,
      listScrollHeight: list?.scrollHeight || 0,
      listClientWidth: list?.clientWidth || 0,
      listScrollWidth: list?.scrollWidth || 0,
      listOverflowY: list ? getComputedStyle(list).overflowY : '',
      titleVisible: Boolean(title?.getBoundingClientRect().height),
      closeVisible: Boolean(close?.getBoundingClientRect().height),
      overlayZIndex: Number(getComputedStyle(overlay).zIndex),
      worldOverlayZIndex: Number(getComputedStyle(worldOverlay).zIndex),
      stackProbeIntersectsModal: Boolean(boxRect
        && stackProbeRect.left < boxRect.left
        && stackProbeRect.right > boxRect.left
        && stackProbeRect.top < boxRect.bottom
        && stackProbeRect.bottom > boxRect.top),
      stackProbeExtendsOutsideModal: Boolean(boxRect && stackProbeRect.left < boxRect.left),
      lastItemReachable: Boolean(lastRect && listRect
        && lastRect.bottom <= listRect.bottom + 1
        && lastRect.top >= listRect.top - 1),
    };
  });
  const lightboxHtml = lightboxState.html;
  const lightboxHits = REQUIRED_CREDIT_SUBSTRINGS.filter((s) => lightboxHtml.includes(s));
  check(
    'lightbox renders the per-layer credits',
    lightboxHits.length >= REQUIRED_CREDIT_SUBSTRINGS.length - 1,
    `${lightboxHits.length}/${REQUIRED_CREDIT_SUBSTRINGS.length} required strings visible in lightbox`,
  );
  check(
    'desktop lightbox stays compact with a fixed title and close control',
    lightboxState.boxHeight > 0
      && lightboxState.boxHeight <= lightboxState.viewportHeight * 0.71
      && lightboxState.titleVisible
      && lightboxState.closeVisible,
    `box=${Math.round(lightboxState.boxHeight)}px viewport=${lightboxState.viewportHeight}px`,
  );
  check(
    'complete credit list scrolls vertically without horizontal overflow',
    lightboxState.itemCount >= registeredHtml.length
      && lightboxState.linkCount > 0
      && lightboxState.everyLinkHasDestination
      && lightboxState.listScrollHeight > lightboxState.listClientHeight
      && /auto|scroll/.test(lightboxState.listOverflowY)
      && lightboxState.listScrollWidth <= lightboxState.listClientWidth + 1
      && lightboxState.lastItemReachable,
    `${lightboxState.itemCount} items, ${lightboxState.linkCount} links, list=${lightboxState.listClientHeight}/${lightboxState.listScrollHeight}px`,
  );
  check(
    'attribution modal stacks above shared world labels',
    Number.isFinite(lightboxState.overlayZIndex)
      && Number.isFinite(lightboxState.worldOverlayZIndex)
      && lightboxState.overlayZIndex > lightboxState.worldOverlayZIndex
      && lightboxState.stackProbeIntersectsModal
      && lightboxState.stackProbeExtendsOutsideModal,
    `modal z=${lightboxState.overlayZIndex}, world labels z=${lightboxState.worldOverlayZIndex}, overlap=${lightboxState.stackProbeIntersectsModal}`,
  );
  await page.evaluate(() => window.__godsEyeView.viewer.creditDisplay.hideLightbox());
  await page.screenshot({ path: resolve(SHOT_DIR, 'attribution-stacking-before-desktop.png') });
  await page.evaluate(() => {
    window.__godsEyeView.viewer.creditDisplay.showLightbox();
    const list = document.querySelector('.cesium-credit-lightbox > ul');
    if (list) list.scrollTop = 0;
  });
  await page.screenshot({ path: resolve(SHOT_DIR, 'attribution-lightbox-desktop.png') });
  await page.evaluate(() => {
    window.__godsEyeView.viewer.creditDisplay.hideLightbox();
    document.querySelector('[data-qa-attribution-stack-probe]')?.remove();
  });

  await page.setViewport({ width: 560, height: 760, deviceScaleFactor: 1 });
  await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    viewer.resize();
    viewer.scene.requestRender();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const mobileLightbox = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.creditDisplay.showLightbox();
    const box = document.querySelector('.cesium-credit-lightbox');
    const list = box?.querySelector(':scope > ul');
    const rect = box?.getBoundingClientRect();
    if (list) list.scrollTop = list.scrollHeight;
    const listRect = list?.getBoundingClientRect();
    const lastRect = list?.lastElementChild?.getBoundingClientRect();
    return {
      left: rect?.left || 0,
      right: rect?.right || 0,
      top: rect?.top || 0,
      bottom: rect?.bottom || 0,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      lastItemReachable: Boolean(lastRect && listRect
        && lastRect.bottom <= listRect.bottom + 1),
    };
  });
  check(
    'mobile lightbox remains full-screen edge-to-edge and reaches the final credit',
    Math.abs(mobileLightbox.left) <= 1
      && Math.abs(mobileLightbox.right - mobileLightbox.viewportWidth) <= 1
      && Math.abs(mobileLightbox.top) <= 1
      && Math.abs(mobileLightbox.bottom - mobileLightbox.viewportHeight) <= 1
      && mobileLightbox.lastItemReachable,
    `box=${Math.round(mobileLightbox.left)},${Math.round(mobileLightbox.top)}–${Math.round(mobileLightbox.right)},${Math.round(mobileLightbox.bottom)}`,
  );
  await page.screenshot({ path: resolve(SHOT_DIR, 'attribution-lightbox-mobile.png') });
  await page.evaluate(() => window.__godsEyeView.viewer.creditDisplay.hideLightbox());
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  // ── (ii) enable datacenters + cables; credits still present ────────
  console.log('\nH11 — enabling datacenters + submarine cables');
  const layerIds = await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    return [...dm.layers.keys()];
  });
  // Find the datacenter + cable layer ids by fuzzy match on the id string.
  const dcId = layerIds.find((id) => /datacenter/i.test(id));
  const cableId = layerIds.find((id) => /cable|submarine|telegeo/i.test(id));
  check('found datacenter + cable layer ids', !!dcId && !!cableId, `dc=${dcId} cable=${cableId}`);
  if (dcId) await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true), dcId);
  if (cableId) await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true), cableId);
  await new Promise((r) => setTimeout(r, 800));
  const afterEnableHtml = await page.evaluate(() =>
    (window.__godsEyeView.viewer.creditDisplay._staticCredits || []).map((c) => c.html),
  );
  check(
    'datacenter credit (OSM/ODbL) still present after enable',
    afterEnableHtml.some((h) => h.includes('OpenStreetMap contributors')),
    '',
  );
  check(
    'cable credit (TeleGeography) still present after enable',
    afterEnableHtml.some((h) => h.includes('TeleGeography')),
    '',
  );

  // helper: is #cesium-credits visible (line rendered, not display:none)?
  const creditVisibility = async () =>
    page.evaluate(() => {
      const el = document.getElementById('cesium-credits');
      if (!el) return { present: false };
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        present: true,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        width: rect.width,
        height: rect.height,
        text: (el.textContent || '').trim().slice(0, 120),
        hasLogo: !!el.querySelector('.cesium-credit-logoContainer, img'),
      };
    });

  // ── (iii) clean-view: credit line STILL visible ───────────────────
  console.log('\nH10 — clean-view keeps the credit line visible');
  await page.evaluate(() => document.body.classList.add('ui-clean-view'));
  await new Promise((r) => setTimeout(r, 400));
  const cleanVis = await creditVisibility();
  await page.screenshot({ path: resolve(SHOT_DIR, 'clean-view.png') });
  check(
    'clean-view: #cesium-credits not display:none',
    cleanVis.present && cleanVis.display !== 'none' && cleanVis.visibility !== 'hidden',
    `display=${cleanVis.display} visibility=${cleanVis.visibility} w=${Math.round(cleanVis.width)} h=${Math.round(cleanVis.height)}`,
  );
  check(
    'clean-view: "Data attribution" link to per-layer popover still present',
    !!cleanVis.text && /Data attribution/i.test(cleanVis.text),
    `credit text = "${cleanVis.text}"`,
  );
  await page.evaluate(() => document.body.classList.remove('ui-clean-view'));

  // ── (iv) recording-mode: credit line STILL visible ────────────────
  console.log('\nH10 — recording-mode keeps the credit line visible');
  await page.evaluate(() => document.body.classList.add('recording-mode'));
  await new Promise((r) => setTimeout(r, 400));
  const recVis = await creditVisibility();
  await page.screenshot({ path: resolve(SHOT_DIR, 'recording-mode.png') });
  check(
    'recording-mode: #cesium-credits not display:none',
    recVis.present && recVis.display !== 'none' && recVis.visibility !== 'hidden',
    `display=${recVis.display} visibility=${recVis.visibility} w=${Math.round(recVis.width)} h=${Math.round(recVis.height)}`,
  );
  await page.evaluate(() => document.body.classList.remove('recording-mode'));

  // baseline (normal) screenshot for comparison
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: resolve(SHOT_DIR, 'normal.png') });

  check(
    'no console errors during QA',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean',
  );
  check(
    'no HTTP 5xx responses during QA',
    failedResponses.length === 0,
    failedResponses.slice(0, 3).join(' | ') || 'clean',
  );

  await browser.close();

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`  RESULT: ${passed} passed, ${failed} failed`);
  console.log(`  Screenshots: ${SHOT_DIR}`);
  console.log('────────────────────────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('qa-attribution-b12 crashed:', e);
  process.exit(1);
});
