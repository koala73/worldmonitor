/**
 * Render and load audit for the OpenEye dashboard.
 *
 * The globe smoke test (scripts/qa-cesium-globe.mjs) answers "does the map
 * work?". This answers the broader question you can only ask in a browser:
 * does the application load clean, lay out without overflowing, survive
 * switching between every tab, and survive switching the map between 2D and
 * 3D without leaking a WebGL context.
 *
 * Run against the dev server, not a preview: dev mounts the API gateway, so
 * a fetch failure here is a real failure rather than a missing backend.
 *
 *   npm run dev            # in one terminal
 *   node scripts/qa-render-audit.mjs [--url http://localhost:5199] [--headed]
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHOT_DIR = resolve(ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf('--url');
const BASE = urlIdx !== -1 && argv[urlIdx + 1] ? argv[urlIdx + 1] : 'http://localhost:5199';
const HEADED = argv.includes('--headed');

const failures = [];
const notes = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/**
 * Console noise that is not ours to fix.
 *
 * Third-party embeds (YouTube, Bloomberg) and upstream tile servers are
 * chatty in ways no change in this repo affects. Everything else is signal —
 * the point of an audit is to keep that list short and justified.
 */
const IGNORED_CONSOLE = [
  // Third-party embeds and ad/analytics blocking.
  /Failed to load resource.*\b(youtube|ytimg|doubleclick|googletagmanager|bloomberg)\b/i,
  /ERR_BLOCKED_BY_(CLIENT|RESPONSE)/i,
  /favicon\.ico/i,
  /\[Violation\]/i,
  /Tile|tile server|Failed to obtain image tile/i,
  /Cesium.*(credit|ion asset)/i,
  /net::ERR_INTERNET_DISCONNECTED/i,

  // Vercel Analytics' debug script is dev-only and the CSP blocks it on
  // purpose — the violation IS the policy working.
  /va\.vercel-scripts\.com/i,
  /unsupported MIME type \('text\/html'\)/i,

  // The dev gateway (sebufApiPlugin in vite.config.ts) mounts a hardcoded
  // subset of the RPC services. For the rest Vite falls through and serves
  // the handler's TypeScript SOURCE, so the client's JSON.parse chokes on
  // its first token. Docker and Vercel bundle every handler under api/**,
  // so this signature is specific to `npm run dev`.
  /is not valid JSON/i,
  /Request failed with status 404/i,
  /with an unparseable body/i,

  // External hosts this repo does not control.
  /maps\.worldmonitor\.app/i,
  /has been blocked by CORS policy/i,

  // Upstream data sources that are simply down right now. These say so in
  // their own words — a real regression does not report "upstream may be
  // down", it throws.
  /\[PizzINT\] Failed/i,
  /upstream may be down/i,
  /Failed to load resource: the server responded with a status of (404|503)/i,
  /Failed to load resource: net::ERR_FAILED/i,
];
const isIgnorable = (text) => IGNORED_CONSOLE.some((re) => re.test(text));

/**
 * Same-origin routes that only forward to a third party. A 5xx from one of
 * these is that third party being down, not a defect in this application.
 */
const UPSTREAM_PROXY_ROUTES = [
  /^\/api\/gpsjam/,
  /^\/api\/rss-proxy/,
  /^\/api\/pizzint/,
  // God's Eye View's credential brokers. Without the matching key in .env
  // these answer 5xx by design — the route exists, the upstream account
  // does not. See src/gev/UPSTREAM.md for which key unlocks which.
  /^\/api\/gev\/(openai|tomtom|cctv)\//,
];

const browser = await puppeteer.launch({
  headless: !HEADED,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
const serverErrors = [];
const proxyErrors = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1728, height: 1080 });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text().slice(0, 400);
    if (!isIgnorable(text)) consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    // The stack is the whole value of catching these — a bare
    // "Cannot read properties of null" names nothing.
    const stack = (err?.stack ?? String(err)).split('\n').slice(0, 6).join('\n');
    pageErrors.push(stack);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() < 400) return;
    if (!url.startsWith(BASE)) return;           // third-party failures are not ours
    if (isIgnorable(url)) return;
    const entry = `${res.status()} ${url.replace(BASE, '')}`;
    // A 5xx is always a bug. A 404 on /api/* under the DEV server usually is
    // not: vite.config.ts's sebufApiPlugin mounts a hardcoded subset of the
    // RPC services, while docker and Vercel bundle every handler under
    // api/**. Those show up as notes so the list stays visible without
    // failing a run for an environment gap.
    const path = url.replace(BASE, '');
    if (UPSTREAM_PROXY_ROUTES.some((re) => re.test(path))) proxyErrors.push(entry);
    else if (res.status() >= 500) serverErrors.push(entry);
    else badResponses.push(entry);
  });

  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('openeye.boot.seen', '1'); } catch { /* private mode */ }
  });

  console.log(`\nLoading ${BASE} …`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const booted = await page
    .waitForFunction(() => document.querySelectorAll('[data-panel]').length > 5,
      { timeout: 120_000, polling: 500 })
    .then(() => true).catch(() => false);
  check('dashboard mounts its panels', booted);
  if (!booted) throw new Error('nothing to audit');

  // Let the first wave of fetches settle before judging the console.
  await new Promise((r) => setTimeout(r, 8000));

  // ── Layout ────────────────────────────────────────────────────────────
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowing = [];
    // A page that scrolls sideways is the single most visible layout bug,
    // and the element responsible is usually one child that ignored a
    // min-width: 0 on a grid or flex track.
    // Anything inside a position:fixed subtree is excluded, not just the
    // fixed element itself. Off-canvas drawers park at `right: -460px` and
    // their CHILDREN then report a right edge past the viewport — true, and
    // entirely by design. Only elements that could actually make the
    // document scroll are interesting.
    const inFixedSubtree = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > doc.clientWidth + 2 && !inFixedSubtree(el)) {
        overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} → ${Math.round(r.right)}px`);
      }
    }
    const map = document.getElementById('mapContainer');
    const mapRect = map?.getBoundingClientRect();
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      overflowing: overflowing.slice(0, 6),
      map: mapRect ? { w: Math.round(mapRect.width), h: Math.round(mapRect.height) } : null,
      panels: document.querySelectorAll('[data-panel]').length,
      visiblePanels: [...document.querySelectorAll('[data-panel]')]
        .filter((el) => el.getBoundingClientRect().height > 0).length,
    };
  });

  check('page does not scroll horizontally',
    layout.docScrollWidth <= layout.docClientWidth + 2,
    `${layout.docScrollWidth} vs ${layout.docClientWidth}`);
  check('no element overflows the viewport width',
    layout.overflowing.length === 0, layout.overflowing.join('; '));
  notes.push(`map container ${layout.map?.w}x${layout.map?.h}`);
  notes.push(`${layout.visiblePanels} of ${layout.panels} panels visible on load`);

  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SHOT_DIR, 'audit-load.png') });

  // ── Tab sweep ─────────────────────────────────────────────────────────
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.openeye-tab')].map((b) => ({
      key: b.dataset.oeKey, label: b.textContent.trim(),
    })));
  notes.push(`tabs: ${tabs.map((t) => t.label).join(' / ')}`);

  const emptyTabs = [];
  for (const tab of tabs) {
    // Only uncaught exceptions are attributed to a tab. Console errors keep
    // arriving from background polls the whole time, so blaming a tab for
    // whatever landed during its window would flag all of them, every run.
    const before = pageErrors.length;
    await page.evaluate((key) => {
      document.querySelector(`.openeye-tab[data-oe-key="${key}"]`)?.click();
    }, tab.key);
    await new Promise((r) => setTimeout(r, 1200));
    const state = await page.evaluate(() => ({
      visible: [...document.querySelectorAll('#panelsGrid [data-panel]')]
        .filter((el) => el.getBoundingClientRect().height > 0).length,
      mapShown: (document.getElementById('mapSection')?.getBoundingClientRect().height ?? 0) > 0,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    }));
    const broke = pageErrors.length > before;
    if (state.visible === 0 && !state.mapShown) emptyTabs.push(tab.label);
    if (state.hScroll) failures.push(`tab ${tab.label} scrolls horizontally`);
    if (broke) failures.push(`tab ${tab.label} raised an error`);
  }
  check('every tab shows something', emptyTabs.length === 0,
    emptyTabs.length ? `empty: ${emptyTabs.join(', ')}` : `${tabs.length} tabs`);

  // ── Section layout ────────────────────────────────────────────────────
  const gotoTab = async (key) => {
    await page.evaluate((k) => {
      document.querySelector(`.openeye-tab[data-oe-key="${k}"]`)?.click();
    }, key);
    await new Promise((r) => setTimeout(r, 1500));
  };
  const sectionState = async () => page.evaluate(() => {
    const vis = (el) => !!el && el.getBoundingClientRect().height > 0;
    const map = document.getElementById('mapContainer');
    const r = map?.getBoundingClientRect();
    return {
      mapVisible: vis(document.getElementById('mapSection')),
      mapW: Math.round(r?.width ?? 0),
      mapH: Math.round(r?.height ?? 0),
      viewportW: document.documentElement.clientWidth,
      viewportH: document.documentElement.clientHeight,
      gridPanels: [...document.querySelectorAll('#panelsGrid [data-panel]')]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => el.dataset.panel),
    };
  });

  const LIVE = ['live-news', 'live-webcams', 'windy-webcams'];

  // The app opens on MAP. Anything else means a stale stored tab key or a
  // model change nobody meant to make.
  const firstTab = tabs[0]?.key;
  check('the app opens on MAP', firstTab === 'map', `first tab is ${firstTab}`);
  check('there is no HOME tab', !tabs.some((t) => t.key === 'home' || t.key === 'world'),
    tabs.map((t) => t.key).join(', '));

  await gotoTab('intelligence');
  const intel = await sectionState();
  // The four panels that used to be the front page were adopted here.
  check('the adopted analysis panels have a home',
    intel.gridPanels.includes('insights') || intel.gridPanels.includes('strategic-posture'),
    intel.gridPanels.slice(0, 6).join(', ') || 'no panels');
  check('no section but MAP shows the map', !intel.mapVisible);

  await gotoTab('map');
  const mapTab = await sectionState();
  // "Widescreen" has to mean something measurable. Sharing the screen with
  // the panel grid capped the map near 60% of the width; on its own tab it
  // should take essentially all of it.
  const widthRatio = mapTab.mapW / mapTab.viewportW;
  const heightRatio = mapTab.mapH / mapTab.viewportH;
  check('MAP fills the viewport', mapTab.mapVisible && widthRatio > 0.9 && heightRatio > 0.6,
    `${mapTab.mapW}x${mapTab.mapH} = ${(widthRatio * 100).toFixed(0)}% x `
    + `${(heightRatio * 100).toFixed(0)}% of ${mapTab.viewportW}x${mapTab.viewportH}`);
  check('MAP hides the panel grid', mapTab.gridPanels.length === 0,
    mapTab.gridPanels.join(', '));
  notes.push(`map on its own tab: ${mapTab.mapW}x${mapTab.mapH}`);

  await gotoTab('live');
  const liveTab = await sectionState();
  check('LIVE carries the feeds and not the map',
    liveTab.gridPanels.some((k) => LIVE.includes(k)) && !liveTab.mapVisible,
    liveTab.gridPanels.join(', ') || 'no panels');

  // Back to the first tab (MAP) for the checks below.
  await page.evaluate((key) => {
    document.querySelector(`.openeye-tab[data-oe-key="${key}"]`)?.click();
  }, tabs[0]?.key);
  await new Promise((r) => setTimeout(r, 1500));

  // Every mounted grid panel must be accounted for: either the active tab
  // claims it, or it carries `.oe-tab-hidden`. A panel in neither state is
  // one that escaped the filter and renders on every tab — which is what a
  // stale tab model looks like after a settings change or a late lazy mount.
  const escaped = await page.evaluate(() => {
    const active = document.querySelector('.openeye-tab.active')?.dataset.oeKey ?? null;
    const loose = [...document.querySelectorAll('#panelsGrid [data-panel]')]
      .filter((el) => !el.classList.contains('oe-tab-hidden')
        && el.getBoundingClientRect().height > 0)
      .map((el) => el.dataset.panel);
    return { active, loose };
  });
  // On MAP the grid is empty by design, so run this where panels exist.
  check('no grid panel escapes the tab filter',
    escaped.active !== 'map' || escaped.loose.length === 0,
    `${escaped.active}: ${escaped.loose.slice(0, 5).join(', ') || 'none loose'}`);

  // ── Mobile ────────────────────────────────────────────────────────────
  //
  // The tab bar is desktop-only, but `applyFilter` stamps `data-oe-tab` and
  // `.oe-tab-hidden` at every width — the composition contract is that the
  // CSS which ACTS on them is gated at 769px. Get that wrong and a phone
  // opening on the MAP tab loses its entire panel grid to a rule meant for
  // desktop. Cheap to check, invisible until someone opens it on a phone.
  const mobile = await browser.newPage();
  try {
    await mobile.emulate({
      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
        + ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await mobile.evaluateOnNewDocument(() => {
      try { localStorage.setItem('openeye.boot.seen', '1'); } catch { /* private mode */ }
    });
    await mobile.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await mobile.waitForFunction(() => document.querySelectorAll('[data-panel]').length > 5,
      { timeout: 120_000, polling: 500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    const m = await mobile.evaluate(() => ({
      // Either not built at all (panel-layout skips it below 769px) or built
      // and CSS-hidden. Both are correct; only a visible one is a bug.
      tabBar: (() => {
        const el = document.querySelector('.openeye-tabs');
        if (!el) return 'absent';
        return getComputedStyle(el).display === 'none' ? 'hidden' : 'VISIBLE';
      })(),
      oeTab: document.querySelector('.main-content')?.dataset.oeTab ?? null,
      visiblePanels: [...document.querySelectorAll('#panelsGrid [data-panel]')]
        .filter((el) => el.getBoundingClientRect().height > 0).length,
      mapVisible: (document.getElementById('mapSection')?.getBoundingClientRect().height ?? 0) > 0,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    }));
    check('mobile does not show the desktop tab bar', m.tabBar !== 'VISIBLE', m.tabBar);
    check('mobile still shows its panels despite the MAP tab filter',
      m.visiblePanels > 0, `data-oe-tab=${m.oeTab}, ${m.visiblePanels} panels, map=${m.mapVisible}`);
    check('mobile does not scroll horizontally', !m.hScroll);
    await mobile.screenshot({ path: resolve(SHOT_DIR, 'audit-mobile.png') });
  } finally {
    await mobile.close();
  }

  // ── 2D ↔ 3D cycling ───────────────────────────────────────────────────
  //
  // Each switch tears down one renderer and builds the other. A renderer
  // that does not release its WebGL context leaves the canvas behind, and
  // browsers cap live contexts at ~16 — so a leak here is a map that stops
  // rendering after a dozen switches, which is exactly the kind of bug that
  // only shows up in a long session.
  const canvasCounts = [];
  const globeAlive = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelector('.map-dim-btn[data-mode="globe"]')?.click());
    // Cesium + Google 3D Tiles under SwiftShader is slow; wait for the viewer
    // rather than guessing, so this measures teardown and not a race with
    // boot. A mount that never completes is itself a failure.
    globeAlive.push(await page
      .waitForFunction(() => !!window.__godsEyeView?.viewer
        && !window.__godsEyeView.viewer.isDestroyed(), { timeout: 60_000, polling: 500 })
      .then(() => true).catch(() => false));
    await page.evaluate(() => document.querySelector('.map-dim-btn[data-mode="flat"]')?.click());
    await new Promise((r) => setTimeout(r, 6000));
    canvasCounts.push(await page.evaluate(() => document.querySelectorAll('canvas').length));
  }
  // Every mount must succeed, not just the first: God's Eye View keeps state
  // in module singletons, and one that survives teardown holding a destroyed
  // viewer kills the next mount without killing the first.
  check('the globe can be mounted more than once', globeAlive.every(Boolean),
    globeAlive.map((ok, i) => `#${i + 1}:${ok ? 'ok' : 'DEAD'}`).join(' '));
  const leaked = canvasCounts.at(-1) - canvasCounts[0];
  check('switching 2D/3D does not leak canvases', leaked <= 0,
    `canvas count after each cycle: ${canvasCounts.join(' → ')}`);

  // ── Console verdict ───────────────────────────────────────────────────
  check('no uncaught page errors', pageErrors.length === 0,
    `${pageErrors.length} error(s)`);
  if (pageErrors.length) {
    console.log('\n  page errors:');
    for (const e of [...new Set(pageErrors)].slice(0, 5)) {
      console.log(e.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
  check('no console errors', consoleErrors.length === 0,
    `${consoleErrors.length} error(s)`);
  check('no same-origin server errors', serverErrors.length === 0,
    serverErrors.length ? [...new Set(serverErrors)].slice(0, 4).join(', ') : '');
  if (badResponses.length) {
    notes.push(`${new Set(badResponses).size} same-origin 404s (dev gateway mounts a subset of api/**)`);
  }
  if (proxyErrors.length) {
    notes.push(`${new Set(proxyErrors).size} upstream-proxy failures (third party is down)`);
  }

  await page.screenshot({ path: resolve(SHOT_DIR, 'audit-final.png') });
  await writeFile(resolve(SHOT_DIR, 'audit-console.log'),
    [
      '# page errors', ...pageErrors,
      '', '# console errors', ...consoleErrors,
      '', '# same-origin 5xx', ...serverErrors,
      '', '# same-origin 404s', ...badResponses,
    ].join('\n'));
} finally {
  await browser.close();
}

if (consoleErrors.length) {
  console.log('\n  console errors:');
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`    ${e}`);
}
if (badResponses.length) {
  console.log('\n  same-origin 404s (dev gateway gap unless also missing in docker):');
  for (const r of [...new Set(badResponses)].slice(0, 12)) console.log(`    ${r}`);
}
if (serverErrors.length) {
  console.log('\n  same-origin 5xx:');
  for (const r of [...new Set(serverErrors)].slice(0, 12)) console.log(`    ${r}`);
}
if (notes.length) {
  console.log('');
  for (const n of notes) console.log(`  note: ${n}`);
}

console.log('');
if (failures.length) {
  console.error(`FAILED: ${[...new Set(failures)].join(', ')}`);
  process.exit(1);
}
console.log('Render audit passed.');
