#!/usr/bin/env node
/**
 * qa-firstrun — the mission launcher's contract, proved in the real app.
 *
 * The unit suite pins the show policy and the mission table against fakes. This
 * harness answers the questions only a running app can: does a mission actually
 * enable those layers, does the camera actually reach the globe, does a keyless
 * visitor actually get the honest FIRMS state instead of a silent empty layer,
 * and does any of it disturb the reasonable-defaults startup look.
 *
 * It also captures the owner's taste-pass screenshots into qa-shots/firstrun/.
 *
 * Usage:
 *   node scripts/qa-firstrun.mjs --url http://localhost:4278
 *   node scripts/qa-firstrun.mjs --url http://localhost:4278 --teeth
 *
 * `--teeth` is the negative control: it suppresses the launcher's own reveal, so
 * every rendered/behavioral assertion below must go RED. A green --teeth run
 * means the assertions are not measuring what they claim to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const getOpt = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = getOpt('--url', 'http://localhost:4173').replace(/\/$/, '');
const TEETH = args.includes('--teeth');
const HEADFUL = args.includes('--headful');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'qa-shots', 'firstrun');

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Version-pinned Chrome-for-Testing over the auto-updating system Chrome.
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const results = [];
let currentSection = 'setup';
function record(name, ok, detail) {
  results.push({ name, ok, detail, section: currentSection });
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Run one independent section.
 *
 * Sections are isolated on purpose. The first version of this harness ran as a
 * single straight line, so the FIRST throw ended the run — under `--teeth` that
 * meant it stopped at 9 of 38 checks and never exercised the mission, viewport
 * or console assertions at all, while still claiming the control had teeth. A
 * throw now fails its own section and the rest still run, which is what makes
 * the per-section reachability tally below meaningful.
 */
async function section(name, body) {
  currentSection = name;
  console.log(`\n  \x1b[2m── ${name} ──\x1b[0m`);
  try {
    await body();
  } catch (error) {
    record(`[${name}] section completed without throwing`, false, error.message);
  }
}

const LAUNCHER = '#first-run-launcher';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the app and wait for the launcher to settle one way or the other.
 *
 * `errorSink` is emptied on the way out: navigating away aborts whatever the
 * previous page had in flight, and Chrome reports those aborts as
 * "TypeError: Failed to fetch". Those belong to this harness, not to the app,
 * so the console assertion only ever judges the page it is actually looking at.
 */
async function open(page, { hash = '', query = '', clearAll = true, clearSession = true, errorSink = null } = {}) {
  await page.goto(`${APP_URL}/${query}${hash}`, { waitUntil: 'domcontentloaded' });
  if (clearAll || clearSession) {
    await page.evaluate((all) => {
      if (all) localStorage.clear();
      sessionStorage.clear();
    }, clearAll);
    await page.goto(`${APP_URL}/${query}${hash}`, { waitUntil: 'domcontentloaded' });
  }
  // The launcher is revealed after the loading cover yields (~T+1.9 s).
  await page.waitForFunction(
    (sel) => !!window.__godsEyeView?.styleManager
      && (document.querySelector(sel)?.classList.contains('visible') || !document.querySelector(sel)),
    { timeout: 45000 },
    LAUNCHER,
  ).catch(() => {});
  await sleep(400);
  if (errorSink) errorSink.length = 0;
}

const launcherVisible = (page) => page.evaluate(
  (sel) => !!document.querySelector(sel)?.classList.contains('visible'),
  LAUNCHER,
);

const appState = (page) => page.evaluate(() => {
  const gev = window.__godsEyeView || {};
  const sm = gev.styleManager;
  const dm = gev.dataManager;
  const carto = sm?.viewer?.camera?.positionCartographic;
  const layers = {};
  const counts = {};
  const all = dm?.getAll?.() || [];
  for (const id of [
    'local-datacenters', 'local-dams', 'telegeography-submarine-cables',
    'local-firms', 'earthquakes', 'flights', 'military', 'rocket-launches', 'satellites',
  ]) {
    layers[id] = !!dm?.isEnabled?.(id);
    counts[id] = all.find((entry) => entry.id === id)?.stats?.count ?? null;
  }
  const firms = all.find((entry) => entry.id === 'local-firms');
  return {
    heightKm: carto ? Math.round(carto.height / 1000) : null,
    layers,
    counts,
    contextMode: sm?.getContextModeState?.().mode ?? null,
    firmsError: firms?.stats?.error ?? null,
    firmsCount: firms?.stats?.count ?? null,
    detectionOverridden: sm?._detectionUserOverridden ?? null,
    durable: localStorage.getItem('gev:first-run-mission:v1'),
    session: sessionStorage.getItem('gev:first-run-mission-session:v1'),
    layerStateBlob: localStorage.getItem('gev:layer-state:v2'),
    allocation: localStorage.getItem('gev:detection-allocation:v1'),
  };
});

/**
 * Click a mission tile, wait for the launcher to close, then let the layers it
 * asked for actually settle. Asserting (or screenshotting) before the feeds have
 * drawn measures the harness's own impatience, not the mission.
 */
/**
 * Start recording every state the GLOBAL loading chip passes through. The chip
 * is transient — sampling it once after a mission would miss a failure banner
 * that flashed and cleared — so this watches it continuously instead.
 */
async function watchLoadingChip(page) {
  await page.evaluate(() => {
    window.__chipSeen = [];
    const el = document.getElementById('global-loading-status');
    if (!el) return;
    const sample = () => {
      const label = document.getElementById('global-loading-label')?.textContent?.trim() || '';
      const state = el.dataset.state || '';
      const hidden = el.hidden;
      const last = window.__chipSeen[window.__chipSeen.length - 1];
      const entry = `${hidden ? 'hidden' : 'shown'}:${state}:${label}`;
      if (entry !== last) window.__chipSeen.push(entry);
    };
    sample();
    window.__chipObserver?.disconnect();
    window.__chipObserver = new MutationObserver(sample);
    window.__chipObserver.observe(el, {
      attributes: true, childList: true, subtree: true, characterData: true,
    });
  }).catch(() => {});
}

const readLoadingChip = (page) => page.evaluate(() => window.__chipSeen || []);

async function pick(page, choice, { timeout = 40000, settle = [] } = {}) {
  await page.click(`[data-first-run-choice="${choice}"]`);
  await page.waitForFunction(
    (sel) => !document.querySelector(sel) || !document.querySelector(sel).classList.contains('visible'),
    { timeout },
    LAUNCHER,
  ).catch(() => {});
  if (settle.length) {
    await page.evaluate(async (ids) => {
      const dm = window.__godsEyeView?.dataManager;
      await Promise.all(ids.map((id) => dm?.waitForLayerSettled?.(id)));
    }, settle).catch(() => {});
  }
  // Plus a render beat: settled data still has to reach the framebuffer.
  await sleep(settle.length ? 3500 : 1500);
}

/** Every section the run is expected to reach; the teeth verdict requires all. */
const EXPECTED_SECTIONS = [
  'show-policy', 'esc-arbitration',
  'mission-environmental', 'mission-contacts', 'mission-space', 'mission-explore',
  'viewports', 'console',
];

/*
 * Sections that are NOT expected to go red under --teeth.
 *
 * `console` is a hygiene check, not a launcher check: with the launcher removed
 * the page legitimately still logs nothing, so demanding a red there would be
 * demanding a false failure. Everything else exists to test the launcher and
 * must collapse without it. This list is deliberately tiny and named — it is the
 * one place a section can be excused, so an unjustified entry is visible.
 */
const HYGIENE_SECTIONS = ['console'];

/**
 * ESC arbitration — the two defects that motivated the yield design, plus the
 * yield itself. Driven through the real body classes, because that is exactly
 * what Cockpit and the Scene director set.
 */
async function runArbitrationSection(page, { shots, consoleErrors }) {
  await section('esc-arbitration', async () => {
    const launcherState = () => page.evaluate((sel) => {
      const node = document.querySelector(sel);
      const rect = node?.getBoundingClientRect();
      // Topmost, not merely present: hit-test the card's own centre the way the
      // launcher does, so an overlay that leaves the box intact is visible here.
      const hit = rect && rect.width > 0 && rect.height > 0
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        present: !!node,
        classVisible: !!node?.classList.contains('visible'),
        // Real visibility: `display:none` yields zero client rects.
        onScreen: !!node && node.getClientRects().length > 0,
        topmost: !!(hit && node && node.contains(hit)),
        session: sessionStorage.getItem('gev:first-run-mission-session:v1'),
      };
    }, LAUNCHER);

    // ── Blocker 2 repro: a Scene starts while the launcher is up ────────────
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    const beforeScene = await launcherState();
    record('the launcher is up before the scene starts', beforeScene.onScreen);

    await page.evaluate(() => document.body.classList.add('scene-playback-mode'));
    await sleep(300);
    const duringScene = await launcherState();
    record(
      'a scene taking the screen makes the launcher YIELD, not just hide',
      beforeScene.onScreen && !duringScene.classVisible,
      `onScreen=${duringScene.onScreen} classVisible=${duringScene.classVisible} — a hidden card that kept "visible" is the defect`,
    );
    record('yielding is session-scoped, like any other dismissal',
      duringScene.session === 'dismissed', `session=${duringScene.session}`);

    // The key that used to dismiss an invisible launcher must now do nothing
    // to it — proven by the scene class still being set afterwards.
    await page.keyboard.press('Escape');
    await sleep(300);
    const afterEsc = await page.evaluate(() => ({
      sceneStillOn: document.body.classList.contains('scene-playback-mode'),
    }));
    record(
      'ESC during a scene never lands on the launcher',
      afterEsc.sceneStillOn,
      afterEsc.sceneStillOn ? 'scene class untouched by the launcher' : 'something else consumed the key',
    );
    await page.evaluate(() => document.body.classList.remove('scene-playback-mode'));
    await sleep(200);
    const afterScene = await launcherState();
    record('a yielded launcher does not pop back when the scene ends',
      !afterScene.classVisible, `classVisible=${afterScene.classVisible}`);

    // ── Blocker 3 repro: Cockpit engages while the launcher is up ───────────
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    const beforeCockpit = await launcherState();
    record('the launcher is up before cockpit engages', beforeCockpit.onScreen);
    await page.evaluate(() => document.body.classList.add('cockpit-mode'));
    await sleep(300);
    const duringCockpit = await launcherState();
    record(
      'cockpit engaging makes the launcher YIELD before it can contest ESC',
      beforeCockpit.onScreen && !duringCockpit.classVisible,
      `classVisible=${duringCockpit.classVisible} — cockpit registers its capture listener first, so stacking must never arise`,
    );
    await page.evaluate(() => document.body.classList.remove('cockpit-mode'));
    await sleep(200);

    // ── Blocker repro: a surface that takes the screen with NO class ────────
    // The attribution lightbox is full-screen at z-index 200 against the card's
    // 175 and announces itself with nothing at all. The card keeps its box, so a
    // getClientRects()-only check called it visible: ESC dismissed a launcher
    // the visitor could not see, and burned the session flag, behind a lightbox
    // that binds no ESC of its own and therefore stayed open.
    const lightboxState = () => page.evaluate(() => {
      const overlay = document.querySelector('.cesium-credit-lightbox-overlay');
      return {
        present: !!overlay,
        shown: !!overlay && getComputedStyle(overlay).display !== 'none',
        z: overlay ? getComputedStyle(overlay).zIndex : null,
      };
    });

    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    const beforeLightbox = await launcherState();
    record('the launcher is up before the attribution lightbox opens', beforeLightbox.onScreen);

    const linkClicked = await page.evaluate(() => {
      const link = document.querySelector('#cesium-credits .cesium-credit-expand-link');
      link?.click();
      return !!link;
    });
    await sleep(300);
    const lightboxUp = await lightboxState();
    record(
      'the real "Data attribution" lightbox opens above the card',
      linkClicked && lightboxUp.shown && lightboxUp.z === '200',
      `link=${linkClicked} shown=${lightboxUp.shown} z-index=${lightboxUp.z} vs the launcher's 175`,
    );
    const buried = await launcherState();
    record(
      'an unclassed overlay leaves the card MEASURABLE but no longer topmost',
      buried.onScreen && !buried.topmost,
      `onScreen=${buried.onScreen} topmost=${buried.topmost} — the class watch cannot see this surface at all`,
    );

    await page.keyboard.press('Escape');
    await sleep(400);
    const escUnderLightbox = await launcherState();
    const lightboxAfterEsc = await lightboxState();
    record(
      'ESC under the lightbox never lands on the buried launcher',
      beforeLightbox.onScreen && escUnderLightbox.classVisible,
      `classVisible=${escUnderLightbox.classVisible} — the card was up, covered, and must stay up`,
    );
    record(
      'that ESC does not burn the session flag either',
      beforeLightbox.onScreen && escUnderLightbox.session !== 'dismissed',
      `session=${escUnderLightbox.session}`,
    );
    record(
      'the lightbox keeps its OWN ESC semantics (Cesium binds none, so it stays)',
      lightboxAfterEsc.shown,
      `overlay shown=${lightboxAfterEsc.shown}`,
    );

    // The guard disarms the launcher; it must never break it. Close the overlay
    // the way a visitor does and the key comes straight back.
    await page.evaluate(() => document.querySelector('.cesium-credit-lightbox-close')?.click());
    await sleep(300);
    const uncovered = await launcherState();
    record('closing the lightbox hands the card back the key',
      uncovered.topmost, `topmost=${uncovered.topmost}`);
    await page.keyboard.press('Escape');
    await sleep(600);
    const afterUncoveredEsc = await launcherState();
    record(
      'ESC dismisses normally again once nothing is on top',
      beforeLightbox.onScreen && !afterUncoveredEsc.classVisible
        && afterUncoveredEsc.session === 'dismissed',
      `classVisible=${afterUncoveredEsc.classVisible} session=${afterUncoveredEsc.session}`,
    );

    // ── Blocker repro: a control that claims only the KEY ───────────────────
    // The compact Radio disclosure closes on ESC from a capture listener bound
    // long before this module exists. It called stopPropagation(), which does
    // NOT stop later listeners on the same document — so one key closed the
    // disclosure AND dismissed the launcher. The card is not hiding behind this
    // one and must not yield to it: the key is simply already spoken for.
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    const beforeRadio = await launcherState();
    record('the launcher is up before the radio disclosure opens', beforeRadio.onScreen);
    const radioOpened = await page.evaluate(() => {
      document.getElementById('context-radio-toggle-btn')?.click();
      return !!document.getElementById('context-radio-dock')?.classList.contains('disclosure-open');
    });
    await sleep(250);
    record('the compact Radio disclosure opens', radioOpened);
    const withRadio = await launcherState();
    record(
      'a small disclosure is a key contest, not a screen takeover — no yield',
      withRadio.classVisible && withRadio.topmost,
      `classVisible=${withRadio.classVisible} topmost=${withRadio.topmost}`,
    );

    await page.keyboard.press('Escape');
    await sleep(400);
    const radioAfterEsc = await page.evaluate(() => (
      !!document.getElementById('context-radio-dock')?.classList.contains('disclosure-open')
    ));
    const launcherAfterRadioEsc = await launcherState();
    record('ESC closes the disclosure', radioOpened && !radioAfterEsc,
      `disclosure still open=${radioAfterEsc}`);
    record(
      'that SAME ESC does not also dismiss the launcher',
      beforeRadio.onScreen && launcherAfterRadioEsc.classVisible
        && launcherAfterRadioEsc.session !== 'dismissed',
      `classVisible=${launcherAfterRadioEsc.classVisible} session=${launcherAfterRadioEsc.session} — one key, one action`,
    );
    // ...and the NEXT press is the launcher's, so nothing was permanently taken.
    await page.keyboard.press('Escape');
    await sleep(600);
    const escAfterRadioClosed = await launcherState();
    record(
      'the next ESC belongs to the launcher again',
      beforeRadio.onScreen && !escAfterRadioClosed.classVisible
        && escAfterRadioClosed.session === 'dismissed',
      `classVisible=${escAfterRadioClosed.classVisible} session=${escAfterRadioClosed.session}`,
    );

    // ── Deferred reveal: a surface already up when the launcher would show ──
    // The class goes on as soon as the app exists, which is well before the
    // launcher's reveal (~T+1.9s), so init genuinely sees a screen it does not
    // own. Cockpit's own exit() strips this class, so it is re-asserted right up
    // to the check rather than set once and hoped for.
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${APP_URL}/?welcome=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.body, { timeout: 45000 }).catch(() => {});
    const holdCockpit = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        await page.evaluate(() => document.body?.classList.add('cockpit-mode')).catch(() => {});
        await sleep(200);
      }
    };
    await holdCockpit(5000);
    const withCockpitUp = await launcherState();
    const classHeld = await page.evaluate(() => document.body.classList.contains('cockpit-mode'));
    record(
      'the launcher WAITS rather than appearing over a surface already up',
      classHeld && withCockpitUp.present && !withCockpitUp.classVisible,
      `cockpitClassHeld=${classHeld} present=${withCockpitUp.present} classVisible=${withCockpitUp.classVisible}`,
    );
    record('waiting does not burn the session flag',
      withCockpitUp.session !== 'dismissed', `session=${withCockpitUp.session}`);

    // ...and appears once that surface clears.
    await page.evaluate(() => document.body.classList.remove('cockpit-mode'));
    await sleep(800);
    const afterCockpitCleared = await launcherState();
    record('the launcher appears once the surface clears',
      afterCockpitCleared.onScreen, `onScreen=${afterCockpitCleared.onScreen}`);
    if (afterCockpitCleared.onScreen) shots.push(await shoot(page, 'arbitration-revealed-after-cockpit'));
  });
}

async function shoot(page, name) {
  // The teeth run deliberately has no launcher, so its frames are pictures of
  // an empty loading screen. Writing them would overwrite the real evidence
  // this directory exists to hold, so the control captures nothing.
  if (TEETH) return `${name}.png (skipped: teeth run)`;
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return path.relative(ROOT, file);
}

async function main() {
  console.log('\nFirst-Run Mission Launcher QA');
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Mode    : ${TEETH ? 'TEETH (launcher suppressed — expect RED)' : 'normal'}\n`);

  try {
    const response = await fetch(`${APP_URL}/`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Dev server not reachable at ${APP_URL}: ${error.message}`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const executablePath = CHROME_CANDIDATES.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--window-size=1440,900',
    ],
  });

  const shots = [];
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!/Failed to load resource.*(404|429|503)/i.test(text)) consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    if (TEETH) {
      // Negative control: the markup never arrives, so nothing can be revealed.
      await page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('first-run-launcher')?.remove();
        });
      });
    }

    await section('show-policy', async () => {
      await open(page);
      const freshVisible = await launcherVisible(page);
      record('a fresh session gets the launcher', freshVisible);
      if (freshVisible) shots.push(await shoot(page, 'launcher-desktop'));

      const focused = await page.evaluate(() => document.activeElement?.dataset?.firstRunChoice ?? null);
      record('focus lands on the first mission tile', focused === 'contacts', `activeElement=${focused}`);

      // The card is a flex column (so its list can scroll on short viewports),
      // and an author `display` on this id outranks the UA's `[hidden]` rule.
      // Prove the attribute still hides it, or it sits in the a11y tree from
      // page parse until reveal — and on a share link, until removal.
      const hiddenHonored = await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        node.hidden = true;
        const display = getComputedStyle(node).display;
        node.hidden = false;
        return display;
      }, LAUNCHER);
      record('the hidden attribute still hides the flex card', hiddenHonored === 'none',
        `computed display while hidden = ${hiddenHonored}`);

      const tiles = await page.$$eval('[data-first-run-choice]', (nodes) => nodes.map((n) => n.dataset.firstRunChoice));
      record(
        'four tiles in the owner\'s order',
        JSON.stringify(tiles) === JSON.stringify(['contacts', 'space-missions', 'environmental', 'explore']),
        tiles.join(' · '),
      );

      // ESC dismisses. Stated as a TRANSITION (was up, now gone) — "not visible"
      // alone passes vacuously whenever the launcher never appeared at all.
      await page.keyboard.press('Escape');
      await sleep(600);
      const state = await appState(page);
      record('ESC dismisses the launcher', freshVisible && !(await launcherVisible(page)),
        freshVisible ? 'visible → dismissed' : 'never appeared, so nothing was dismissed');
      record('ESC writes the SESSION flag only', state.session === 'dismissed' && state.durable === null,
        `session=${state.session} durable=${state.durable}`);

      // Same session, reload → stays gone. Also non-vacuous: it only means
      // anything if this session had seen the launcher in the first place.
      await open(page, { clearAll: false, clearSession: false });
      record('a reload in the same session does not re-nag',
        freshVisible && !(await launcherVisible(page)),
        freshVisible ? 'seen this session, stayed away on reload' : 'never appeared, so the check is empty');

      // New session (sessionStorage cleared, localStorage kept) → back.
      await open(page, { clearAll: false, clearSession: true });
      record('the next fresh session gets it again', await launcherVisible(page));

      // Checkbox → durable suppression.
      await page.click('[data-first-run-suppress]');
      await sleep(200);
      const ticked = await appState(page);
      record('the checkbox writes durable suppression immediately', ticked.durable === 'suppressed', `durable=${ticked.durable}`);
      await page.keyboard.press('Escape');
      await sleep(400);
      await open(page, { clearAll: false, clearSession: true });
      record('a suppressed profile stays quiet in later sessions',
        ticked.durable === 'suppressed' && !(await launcherVisible(page)),
        ticked.durable === 'suppressed' ? 'suppressed and stayed away' : 'nothing was ever suppressed');

      // ?welcome=1 outranks the checkbox; ?welcome=0 suppresses a fresh session.
      await open(page, { clearAll: false, clearSession: true, query: "?welcome=1", errorSink: consoleErrors });
      record('?welcome=1 replays past durable suppression', await launcherVisible(page));
      await open(page, { query: '?welcome=0' });
      record('?welcome=0 suppresses a fresh session', !(await launcherVisible(page)));

      // Share links bypass entirely.
      await open(page, { hash: '#lat=30.2672&lon=-97.7431&alt=2500' });
      const shareState = await page.evaluate(() => !!window.__godsEyeView?.styleManager?.hasShareState);
      const shareShowed = await launcherVisible(page);
      record('a share link bypasses the launcher', shareState && !shareShowed,
        `hasShareState=${shareState} launcherVisible=${shareShowed}`);
    });

    await runArbitrationSection(page, { shots, consoleErrors });

    // ── Mission outcomes ────────────────────────────────────────────────────
    // One section PER MISSION: a throw in one (a tile that never rendered under
    // --teeth, say) must not take the other four down with it, or the teeth
    // tally reports "reached" for assertions that never ran.
    let state;
    let before;
    await section('mission-environmental', async () => {
    // Full clear, not just the session: layer enables are DURABLE, so without it
    // an earlier mission's layers ride along and this stops measuring
    // Environmental alone (and its screenshot stops showing it alone).
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    before = await appState(page);
    await watchLoadingChip(page);
    await pick(page, 'environmental', { settle: ['earthquakes', 'local-firms'] });
    state = await appState(page);
    record('ENVIRONMENTAL leaves the detection override untouched',
      state.detectionOverridden === false, `_detectionUserOverridden=${state.detectionOverridden}`);
    record('a mission never auto-suppresses itself', state.durable === null, `durable=${state.durable}`);
    record('a mission never writes the detection-allocation pref',
      state.allocation === before.allocation, `${before.allocation} → ${state.allocation}`);
    record('ENVIRONMENTAL enables BOTH of its feeds', state.layers.earthquakes && state.layers['local-firms'],
      `quakes=${state.layers.earthquakes} fires=${state.layers['local-firms']}`);
    record('ENVIRONMENTAL loads real quake records', (state.counts.earthquakes ?? 0) > 0,
      `${state.counts.earthquakes} quakes`);
    record('ENVIRONMENTAL reaches the full-earth camera', state.heightKm !== null && state.heightKm > 12000,
      `${state.heightKm} km`);

    /*
     * The tile optimizes for the FULLY CONFIGURED app, so the assertion splits
     * on what this server actually has rather than pretending one answer fits
     * both. The branch is reported, so a green run always says which one it was.
     *
     *   KEYED   — both datasets must actually arrive, and a failure banner in
     *             that state is a real defect, so the chip IS asserted.
     *   KEYLESS — the LAYER ROW reports KEY REQUIRED while the global batch
     *             completes without presenting that deliberate configuration
     *             state as a failed mission.
     */
    const keyless = state.firmsError === 'KEY REQUIRED';
    console.log(`  \x1b[2m   FIRMS key state: ${keyless ? 'KEYLESS' : 'KEYED'} `
      + `(row="${state.firmsError ?? 'none'}", count=${state.firmsCount})\x1b[0m`);
    if (keyless) {
      record(
        'KEYLESS: the FIRMS row tells the visitor the truth (KEY REQUIRED)',
        state.firmsError === 'KEY REQUIRED',
        `layer row reports "${state.firmsError}"`,
      );
      record(
        'KEYLESS: the quakes half of the tile still delivers in full',
        (state.counts.earthquakes ?? 0) > 0,
        `${state.counts.earthquakes} quakes`,
      );
      const chip = await readLoadingChip(page);
      const failed = chip.filter((entry) => /LOAD FAILED/i.test(entry));
      record(
        'KEYLESS: a missing optional FIRMS key never becomes a global load failure',
        failed.length === 0,
        failed.length
          ? `chip showed: ${failed.join(' | ')}`
          : `chip states seen: ${chip.join(' → ') || 'none'}`,
      );
    } else {
      record(
        'KEYED: both datasets actually arrive',
        (state.counts.earthquakes ?? 0) > 0 && (state.firmsCount ?? 0) > 0,
        `${state.counts.earthquakes} quakes · ${state.firmsCount} fire detections`,
      );
      const chip = await readLoadingChip(page);
      const failed = chip.filter((entry) => /LOAD FAILED/i.test(entry));
      // A STALE served-from-cache FIRMS payload is degraded, not failed, and it
      // still carries data — so the failure test is the banner, not any
      // non-empty error string.
      record(
        'KEYED: no unexpected global failure while the mission runs',
        failed.length === 0,
        failed.length
          ? `chip showed: ${failed.join(' | ')}`
          : `firms row="${state.firmsError ?? 'none'}"; chip states seen: ${chip.join(' → ') || 'none'}`,
      );
    }
    record(
      'no mission turns on the bundled infrastructure layers any more',
      !state.layers['local-datacenters'] && !state.layers['local-dams']
        && !state.layers['telegeography-submarine-cables'],
      'the removed tile left nothing enabling ~5,700 entities at globe scale',
    );
    shots.push(await shoot(page, 'mission-environmental'));
    });

    await section('mission-contacts', async () => {
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    await pick(page, 'contacts');
    state = await appState(page);
    record('LIVE CONTACTS activates the Contacts context mode', state.contextMode === 'flights',
      `contextMode=${state.contextMode}`);
    const panelOpen = await page.evaluate(() => {
      const panel = document.getElementById('global-context-panel');
      return !!panel && !panel.classList.contains('collapsed');
    });
    record('LIVE CONTACTS reveals the Context panel', panelOpen);
    record('LIVE CONTACTS still leaves the detection override untouched',
      state.detectionOverridden === false, `_detectionUserOverridden=${state.detectionOverridden}`);
    shots.push(await shoot(page, 'mission-contacts'));
    });

    await section('mission-space', async () => {
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    await pick(page, 'space-missions');
    state = await appState(page);
    record('SPACE MISSIONS activates its context mode', state.contextMode === 'space-missions',
      `contextMode=${state.contextMode}`);
    shots.push(await shoot(page, 'mission-space-missions'));
    });

    await section('mission-explore', async () => {
    await open(page, { query: "?welcome=1", errorSink: consoleErrors });
    const beforeExplore = await appState(page);
    await pick(page, 'explore');
    state = await appState(page);
    record('EXPLORE MANUALLY enables no layer and no context mode',
      Object.values(state.layers).every((on) => !on) && state.contextMode === null,
      Object.entries(state.layers).filter(([, on]) => on).map(([id]) => id).join(', ') || 'nothing enabled');
    // The real claim is that Explore issues no camera command of its own: the
    // arrival fly-in owns the camera and must still be heading down, not out.
    record('EXPLORE MANUALLY never commandeers the camera',
      (state.heightKm ?? 0) < 12000 && (state.heightKm ?? 1e9) <= (beforeExplore.heightKm ?? 1e9),
      `${beforeExplore.heightKm} → ${state.heightKm} km (globe would be 18000)`);
    shots.push(await shoot(page, 'mission-explore'));
    });

    // ── Viewports ───────────────────────────────────────────────────────────
    await section('viewports', async () => {
    // Portrait phone, LANDSCAPE phone (the short viewport that clipped the card
    // at both ends before it grew a max-height), and a small desktop window.
    const VIEWPORTS = [
      { name: 'mobile-375', width: 375, height: 812, dpr: 2, label: '375 x 812 portrait phone' },
      { name: 'landscape-667', width: 667, height: 390, dpr: 2, label: '667 x 390 landscape phone' },
      { name: 'desktop-800', width: 800, height: 600, dpr: 1, label: '800 x 600 small desktop' },
    ];
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
      await open(page, { query: "?welcome=1", errorSink: consoleErrors });
      const box = await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const list = node.querySelector('.first-run-choices');
        const checkbox = node.querySelector('[data-first-run-suppress]');
        const cb = checkbox?.getBoundingClientRect();
        return {
          top: Math.round(rect.top), bottom: Math.round(rect.bottom),
          left: Math.round(rect.left), right: Math.round(rect.right),
          vw: window.innerWidth, vh: window.innerHeight,
          listScrolls: !!list && list.scrollHeight > list.clientHeight + 1,
          // The checkbox and the status line live OUTSIDE the scrolling list, so
          // they must be on screen at every height, scrollable list or not.
          checkboxOnScreen: !!cb && cb.top >= 0 && cb.bottom <= window.innerHeight,
        };
      }, LAUNCHER);
      const fits = !!box && box.top >= 0 && box.bottom <= box.vh
        && box.left >= 0 && box.right <= box.vw;
      record(
        `the launcher fits a ${vp.label} with no clipping`,
        fits,
        box ? `${box.left},${box.top} → ${box.right},${box.bottom} in ${box.vw}x${box.vh}${box.listScrolls ? ' (list scrolls)' : ''}` : 'absent',
      );
      record(`"Don't show this again" stays on screen at ${vp.width}x${vp.height}`,
        !!box?.checkboxOnScreen);

      // Discoverability: if the list scrolls, the LAST tile must still peek
      // above the fold. A fold that lands exactly between tiles looks like a
      // complete list of four, and the fifth mission is simply never found.
      const peek = await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        const list = node?.querySelector('.first-run-choices');
        if (!list) return null;
        list.scrollTop = 0;
        const tiles = [...list.querySelectorAll('[data-first-run-choice]')];
        const last = tiles[tiles.length - 1];
        if (!last) return null;
        const listBox = list.getBoundingClientRect();
        const lastBox = last.getBoundingClientRect();
        const visible = Math.max(0, Math.min(listBox.bottom, lastBox.bottom) - Math.max(listBox.top, lastBox.top));
        return {
          scrolls: list.scrollHeight > list.clientHeight + 1,
          fraction: lastBox.height ? visible / lastBox.height : 0,
          label: last.dataset.firstRunChoice,
        };
      }, LAUNCHER);
      record(
        `the last mission is discoverable at ${vp.width}x${vp.height}`,
        !!peek && (!peek.scrolls || peek.fraction >= 0.25),
        peek
          ? `${peek.label} ${(peek.fraction * 100).toFixed(0)}% visible${peek.scrolls ? ' (list scrolls)' : ' (no scroll needed)'}`
          : 'absent',
      );

      // Every tile plus the checkbox must still be reachable by Tab when the
      // list scrolls — and reaching one must bring it into view.
      const reach = await page.evaluate(async (sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const targets = [...node.querySelectorAll('[data-first-run-choice], [data-first-run-suppress]')];
        const offscreen = [];
        for (const target of targets) {
          target.focus();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const rect = target.getBoundingClientRect();
          const host = node.getBoundingClientRect();
          if (document.activeElement !== target
            || rect.bottom <= host.top || rect.top >= host.bottom) {
            offscreen.push(target.dataset.firstRunChoice || 'suppress-checkbox');
          }
        }
        return { count: targets.length, offscreen };
      }, LAUNCHER);
      // Derived, not a magic number: every rendered tile plus the checkbox.
      // A hardcoded count silently turns into a failure the day the menu
      // changes, which is exactly what it did when a tile was removed.
      const expectedFocusable = await page.$$eval(
        '[data-first-run-choice]', (nodes) => nodes.length,
      ) + 1;
      record(
        `every tile and the checkbox are keyboard-reachable at ${vp.width}x${vp.height}`,
        !!reach && reach.count === expectedFocusable && reach.offscreen.length === 0,
        reach
          ? `${reach.count}/${expectedFocusable} focusable${reach.offscreen.length ? `, unreachable: ${reach.offscreen.join(', ')}` : ''}`
          : 'absent',
      );
      // The reachability probe above tabs to the last tile and scrolls the list
      // with it. Put it back to the top so the taste-pass shot shows what a
      // visitor actually opens on.
      await page.evaluate((sel) => {
        const list = document.querySelector(sel)?.querySelector('.first-run-choices');
        if (list) list.scrollTop = 0;
        document.activeElement?.blur?.();
      }, LAUNCHER);
      await sleep(250);
      shots.push(await shoot(page, `launcher-${vp.name}`));
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    });

    await section('console', async () => {
      record('no console errors across the whole run', consoleErrors.length === 0,
        consoleErrors.slice(0, 3).join(' | ') || 'clean');
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  const sections = [...new Set(results.map((entry) => entry.section))];
  const tally = sections.map((name) => {
    const rows = results.filter((entry) => entry.section === name);
    return { name, total: rows.length, red: rows.filter((entry) => !entry.ok).length };
  });

  console.log(`\n  Screenshots: ${shots.join(', ')}`);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);

  if (!TEETH) process.exit(failed.length === 0 ? 0 : 1);

  /*
   * NEGATIVE CONTROL VERDICT.
   *
   * Two things have to be true for the control to mean anything, and the old
   * version checked neither properly: it exited ZERO after a single throw ended
   * the run at 9 of 38 checks, so most assertions were never even reached.
   *
   *   (a) the harness must REPORT FAILURE under the stub — a run with the
   *       launcher removed is a failing run, and it exits non-zero like one;
   *   (b) EVERY section must produce at least one red — a section that stays
   *       fully green without the launcher is not testing the launcher.
   *
   * Because (a) means the process always exits non-zero here, the control's own
   * verdict is carried in the exit CODE: 1 = healthy, 2 = the control is broken.
   */
  console.log('  TEETH — per-section reachability (each section must go red):');
  for (const row of tally) {
    const hygiene = HYGIENE_SECTIONS.includes(row.name);
    const ok = row.red > 0 || hygiene;
    const tag = hygiene ? '\x1b[2mHYGN\x1b[0m' : (row.red > 0 ? '\x1b[32mRED \x1b[0m' : '\x1b[31mNONE\x1b[0m');
    void ok;
    console.log(`    [${tag}] ${row.name}: ${row.red}/${row.total} red`);
  }
  const toothless = tally.filter((row) => row.red === 0 && !HYGIENE_SECTIONS.includes(row.name));
  const unreached = EXPECTED_SECTIONS.filter((name) => !sections.includes(name));
  const healthy = failed.length > 0 && toothless.length === 0 && unreached.length === 0;
  if (unreached.length) console.log(`\n  UNREACHED sections: ${unreached.join(', ')}`);
  if (toothless.length) console.log(`  TOOTHLESS sections: ${toothless.map((row) => row.name).join(', ')}`);
  console.log(healthy
    ? `\n  TEETH HEALTHY: harness failed as required (${failed.length} red) and every one of ${tally.length} sections went red. Exit 1 by design.\n`
    : '\n  TEETH BROKEN: the control did not collapse the way it claims to. Exit 2.\n');
  process.exit(healthy ? 1 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
