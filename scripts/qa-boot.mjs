/**
 * The OpenEye boot ceremony, in a real browser.
 *
 * The unit suite (`npm run test:boot`) proves the director drives its stage
 * machine correctly against jsdom. Only a browser can answer the questions
 * that actually matter here: does the ceremony play, does it hand off to the
 * dashboard cleanly, does a repeat visit get the short version, and — the
 * point of putting the ceremony in front at all — is the dashboard
 * downloading WHILE it plays rather than after it.
 *
 *   npm run build && npm run preview
 *   node scripts/qa-boot.mjs [--url http://localhost:5198] [--headed]
 */

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(__dirname, '..', 'qa-shots');

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf('--url');
const BASE = urlIdx !== -1 && argv[urlIdx + 1] ? argv[urlIdx + 1] : 'http://localhost:5198';
const HEADED = argv.includes('--headed');

const failures = [];
const notes = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  headless: !HEADED,
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--no-sandbox',
    '--disable-dev-shm-usage'],
});

/** Load once, recording every stage the boot layer passes through. */
async function run(url, { clearStorage = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));

  await page.evaluateOnNewDocument((clear) => {
    if (clear) { try { localStorage.clear(); } catch { /* private mode */ } }
    // The stage attribute changes faster than any polling loop could sample;
    // observe it instead of racing it.
    window.__stages = [];
    const observe = () => {
      const boot = document.getElementById('boot');
      if (!boot) return void requestAnimationFrame(observe);
      const record = () => {
        const s = boot.dataset.stage;
        if (s && window.__stages[window.__stages.length - 1] !== s) window.__stages.push(s);
      };
      record();
      new MutationObserver(record).observe(boot, {
        attributes: true, attributeFilter: ['data-stage'],
      });
    };
    observe();

    // document.documentElement can still be null at document-start, which is
    // when this runs. Registering the observer regardless left __revealAt
    // permanently null and made the timing comparison below vacuous - it
    // passed on the `null` fallback rather than on evidence.
    window.__revealAt = null;
    const watchReveal = () => {
      const root = document.documentElement;
      if (!root) return void requestAnimationFrame(watchReveal);
      const record = () => {
        if (window.__revealAt === null && root.classList.contains('openeye-revealed')) {
          window.__revealAt = performance.now();
        }
      };
      record();
      new MutationObserver(record).observe(root, {
        attributes: true, attributeFilter: ['class'],
      });
    };
    watchReveal();
  }, clearStorage);

  const startedAt = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  return { page, requests, startedAt };
}

try {
  await mkdir(SHOT_DIR, { recursive: true });

  // -- First visit: the full ceremony -----------------------------------
  console.log(`\nFirst visit - ${BASE}`);
  const first = await run(BASE, { clearStorage: true });

  const sawTerminal = await first.page
    .waitForFunction(() => window.__stages?.includes('CHARACTER'),
      { timeout: 30_000, polling: 100 })
    .then(() => true).catch(() => false);
  check('the terminal plays the full ceremony', sawTerminal);

  if (sawTerminal) {
    await new Promise((r) => setTimeout(r, 1500));
    await first.page.screenshot({ path: resolve(SHOT_DIR, 'boot-ceremony.png') });
  }


  // `openeye-booted`, not the absence of `openeye-booting`: the ceremony's
  // last three beats (reveal, single dissolve, wordmark docks) run after the
  // reveal, and the earlier version of this check sampled in the middle of
  // them - reporting an undocked wordmark and an un-retired terminal that
  // were both perfectly fine a second later.
  const handedOff = await first.page
    .waitForFunction(() => document.documentElement.classList.contains('openeye-booted'),
      { timeout: 90_000, polling: 250 })
    .then(() => true).catch(() => false);
  check('the ceremony hands off to the dashboard', handedOff);

  // The whole reason the ceremony goes first: it should be COVERING a
  // download, not replacing one. The dashboard's chunk must be requested
  // while the terminal is still on screen.
  //
  // Read AFTER the handoff: the reveal is the ceremony's last beat, so
  // sampling this earlier - as the first version did, right after the
  // screenshot - always found no reveal yet and compared against nothing.
  const entryUrl = first.requests.find((r) => /\/assets\/main-[A-Za-z0-9_-]+\.js/.test(r.url))?.url;
  const dashboardReq = first.requests.find(
    (r) => /\/assets\/main-[A-Za-z0-9_-]+\.js/.test(r.url) && r.url !== entryUrl);
  const revealMs = await first.page.evaluate(() => window.__revealAt);
  const reqMs = dashboardReq ? dashboardReq.at - first.startedAt : null;
  // revealMs must be a real number: a null here means the instrumentation
  // missed the reveal, not that the timing was fine.
  check('the dashboard downloads during the ceremony, not after it',
    !!dashboardReq && typeof revealMs === 'number' && reqMs < revealMs,
    dashboardReq
      ? `requested ${reqMs}ms in, reveal at ${revealMs === null ? 'n/a' : Math.round(revealMs)}ms`
      : 'no dashboard chunk requested');

  const after = await first.page.evaluate(() => {
    const app = document.getElementById('app');
    return {
      stages: window.__stages ?? [],
      appVisible: (app?.getBoundingClientRect().height ?? 0) > 0
        && getComputedStyle(app).opacity === '1',
      bootRetired: document.getElementById('boot')?.classList.contains('retired') === true,
      titleDocked: document.getElementById('title')?.classList.contains('docked') === true,
      titleText: document.getElementById('title')?.textContent?.trim() ?? '',
      panels: document.querySelectorAll('[data-panel]').length,
    };
  });
  check('the dashboard is visible and interactive', after.appVisible && after.panels > 5,
    `${after.panels} panels`);
  check('the terminal retires its DOM', after.bootRetired);
  check('the wordmark docks to the corner', after.titleDocked, after.titleText);
  notes.push(`stages: ${after.stages.join(' > ')}`);

  // The dock and the corner handover are the last things to settle; capture
  // the finished state rather than one mid-transition.
  await new Promise((r) => setTimeout(r, 3000));
  const settled = await first.page.evaluate(() => {
    const title = document.getElementById('title');
    return {
      handedOver: title?.classList.contains('handed-over') === true,
      titleOpacity: title ? getComputedStyle(title).opacity : null,
      headerBrand: document.querySelector('.header-brand, .logo, header')?.textContent
        ?.trim().slice(0, 24) ?? '',
    };
  });
  check('the corner is handed to the app header', settled.handedOver
    && Number(settled.titleOpacity) < 0.05,
    `title opacity ${settled.titleOpacity}`);
  await first.page.screenshot({ path: resolve(SHOT_DIR, 'boot-handoff.png') });
  await first.page.close();

  // -- Second visit: the short boot -------------------------------------
  console.log('\nSecond visit (storage kept)');
  const second = await run(BASE);
  await second.page.waitForFunction(
    () => document.documentElement.classList.contains('openeye-booted'),
    { timeout: 90_000, polling: 200 }).catch(() => {});
  const shortStages = await second.page.evaluate(() => window.__stages ?? []);
  check('a repeat visit gets the short boot',
    !shortStages.includes('CHARACTER') && !shortStages.includes('EYE'),
    shortStages.join(' > '));

  // Short mode never draws the eye artwork, so its 435 KB must not be fetched.
  const eyeFetched = second.requests.some((r) => /eye-grid/.test(r.url));
  check('the short boot does not download the eye artwork', !eyeFetched);
  await second.page.close();

  // -- ?boot=full replays it --------------------------------------------
  console.log('\n?boot=full');
  const replay = await run(`${BASE}/?boot=full`);
  const replayed = await replay.page
    .waitForFunction(() => window.__stages?.includes('CHARACTER'),
      { timeout: 30_000, polling: 100 })
    .then(() => true).catch(() => false);
  check('?boot=full replays the ceremony on demand', replayed);
  await replay.page.close();
} finally {
  await browser.close();
}

if (notes.length) {
  console.log('');
  for (const n of notes) console.log(`  note: ${n}`);
}
console.log('');
if (failures.length) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('Boot ceremony QA passed.');
