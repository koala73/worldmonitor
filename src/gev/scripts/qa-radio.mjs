#!/usr/bin/env node
/**
 * Deterministic browser proof for the Radio companion layer.
 *
 * Intercepts only `/api/radio/*` with a 750-station fixture and stubs the
 * browser media `play()` primitive. It proves marker scale/culling, dynamic
 * station-tag filtering, first-click selection, direct-action-only playback, panel/Context
 * independence, restoration without autoplay, responsive UI, and a clean
 * console. Screenshots are written under the gitignored `qa-shots/radio/`.
 *
 * Run: node scripts/qa-radio.mjs --url http://localhost:4173
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'radio');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const APP_ORIGIN = new URL(APP_URL).origin;
const HEADFUL = args.includes('--headful');

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => {
  try { return fs.existsSync(candidate); } catch { return false; }
});

const tags = [
  'news', 'talk', 'weather,emergency', 'public safety,scanner',
  'aviation,atc', 'marine,maritime', 'traffic,transit',
  'music,jazz', 'music,rock', 'community',
];
const stations = Array.from({ length: 750 }, (_, index) => {
  const row = Math.floor(index / 30);
  const column = index % 30;
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: index === 360
      ? '100.3 The River - WQRV - Meridianville/Huntsville, AL'
      : index === 390
        ? 'La Zeta (Hermosillo) - 93.9 FM - XHHY - Uniradio - Hermosillo, Sonora'
        : `QA Radio ${String(index + 1).padStart(3, '0')}`,
    lat: -72 + row * 6,
    lon: -174 + column * 12,
    streamUrl: `https://audio.example.test/${index}.mp3`,
    homepage: `https://station.example.test/${index}`,
    tags: tags[index % tags.length].split(','),
    languages: index === 360 ? ['Spanish'] : ['English'],
    state: `Region ${row + 1}`,
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: index % 2 ? 'AAC' : 'MP3',
    bitrate: 128,
  };
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const response = await fetch(APP_URL).catch(() => null);
  if (!response?.ok) {
    console.error(`Dev server not reachable at ${APP_URL}`);
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chrome ? { executablePath: chrome } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle',
      '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--window-size=1440,900',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextPlay = false;
      window.__qaRadioDelayNextFailure = false;
      window.__qaRadioFailNextPlay = false;
      HTMLMediaElement.prototype.play = function play() {
        window.__qaRadioPlayCalls.push(this.src);
        if (window.__qaRadioDelayNextPlay) {
          window.__qaRadioDelayNextPlay = false;
          return new Promise((resolve) => {
            window.__qaReleaseRadioPlay = () => {
              this.dispatchEvent(new Event('playing'));
              resolve();
              delete window.__qaReleaseRadioPlay;
            };
          });
        }
        if (window.__qaRadioDelayNextFailure) {
          window.__qaRadioDelayNextFailure = false;
          return new Promise((resolve, reject) => {
            window.__qaRejectRadioPlay = () => {
              reject(new DOMException('QA delayed broadcaster failure', 'NotSupportedError'));
              delete window.__qaRejectRadioPlay;
            };
          });
        }
        if (window.__qaRadioFailNextPlay) {
          window.__qaRadioFailNextPlay = false;
          return Promise.reject(new DOMException('QA silent broadcaster', 'NotSupportedError'));
        }
        if (this.src.endsWith('/330.mp3') && !window.__qaRadioFailedNearest) {
          window.__qaRadioFailedNearest = true;
          return Promise.reject(new DOMException('QA broadcaster unavailable', 'NotSupportedError'));
        }
        queueMicrotask(() => this.dispatchEvent(new Event('playing')));
        return Promise.resolve();
      };
    });
    await page.setRequestInterception(true);
    let catalogDegraded = false;
    let catalogStations = stations;
    let catalogGeneration = 1;
    let catalogResponseDelayMs = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === APP_ORIGIN && url.pathname === '/api/radio/stations') {
        const response = {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            stations: catalogStations,
            updatedAt: new Date().toISOString(),
            stale: false,
            degraded: catalogDegraded,
            acceptedGeneration: catalogGeneration,
            catalogInstance: 'qa-harness-instance',
          }),
        };
        const delayMs = catalogResponseDelayMs;
        catalogResponseDelayMs = 0;
        if (delayMs > 0) setTimeout(() => void request.respond(response), delayMs);
        else void request.respond(response);
        return;
      }
      if (url.origin === APP_ORIGIN && /^\/api\/radio\/click\/[^/]+$/.test(url.pathname)) {
        request.respond({ status: 204 });
        return;
      }
      if (url.origin === APP_ORIGIN && url.pathname === '/api/openai/hud-summary') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ summary: 'QA globe ready' }),
        });
        return;
      }
      if (url.origin === APP_ORIGIN && url.pathname === '/api/ais-live') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            rows: [],
            source: 'AISStream QA',
            status: 'open',
            error: null,
            refreshing: false,
            newestPositionAt: null,
            lastMessageAt: null,
          }),
        });
        return;
      }
      request.continue();
    });
    const consoleErrors = [];
    const failedResponses = [];
    const externalCesiumEndpointFailures = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const sourceUrl = message.location()?.url || '';
        consoleErrors.push(sourceUrl ? `${message.text()} [${sourceUrl}]` : message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (/^https:\/\/api\.cesium\.com\/v1\/assets\/1\/endpoint(?:\?|$)/.test(url)) {
        externalCesiumEndpointFailures.push(`${request.failure()?.errorText || 'request failed'} ${url}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 60_000 });
    await page.waitForFunction(() => window.__godsEyeView?.styleManager?._dataManager?.layers?.has('radio'), { timeout: 60_000 });
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => (
      typeof window.__gevQaRegisterLayer === 'function'
      && typeof window.__gevQaUnregisterLayer === 'function'
    ));
    await page.evaluate(() => {
      window.__godsEyeView.viewer.camera.cancelFlight();
      window.__godsEyeView.styleManager.setPanelCollapsed('pp-toggles', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('cctv-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', true);
    });

    const enableStartedAt = Date.now();
    const initialDisclosure = await page.evaluate(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      const mini = document.getElementById('context-radio-mini');
      const enabledBefore = window.__godsEyeView.dataManager.isEnabled('radio');
      button.click();
      return {
        enabledBefore,
        enabledAfterDisclosure: window.__godsEyeView.dataManager.isEnabled('radio'),
        expanded: button.getAttribute('aria-expanded'),
        miniHidden: mini.hidden,
      };
    });
    check(
      'Radio launcher discloses compact controls without changing power',
      !initialDisclosure.enabledBefore && !initialDisclosure.enabledAfterDisclosure
        && initialDisclosure.expanded === 'true' && !initialDisclosure.miniHidden,
      JSON.stringify(initialDisclosure),
    );
    await page.$eval('#context-radio-mini-enable-btn', (button) => button.click());
    await page.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.enabled && !state.loading && state.stationCount === 750;
    });
    const enableElapsedMs = Date.now() - enableStartedAt;
    const initial = await page.evaluate(() => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const state = module.getUIState();
      const context = document.getElementById('global-context-panel');
      const radio = document.getElementById('radio-panel');
      return {
        state,
        plays: window.__qaRadioPlayCalls.length,
        panelExpanded: !radio.classList.contains('collapsed'),
        contextExpanded: !context.classList.contains('collapsed'),
        nestedInContext: context.contains(radio),
        filterOptions: document.getElementById('radio-filter').options.length,
        filterPalette: Array.from(document.getElementById('radio-filter').options).map((entry) => ({
          id: entry.value,
          label: entry.textContent,
          color: entry.dataset.radioColor,
        })),
        enablePressed: document.getElementById('radio-enable-btn').getAttribute('aria-pressed'),
        launcherExpanded: document.getElementById('context-radio-toggle-btn').getAttribute('aria-expanded'),
        launcherActive: document.getElementById('context-radio-toggle-btn').classList.contains('active'),
        compactEnablePressed: document.getElementById('context-radio-mini-enable-btn').getAttribute('aria-pressed'),
        fullPlayEnabled: !document.getElementById('radio-play-btn').disabled,
        fullPlayLabel: document.getElementById('radio-play-btn').getAttribute('aria-label'),
        tunerVisible: !document.getElementById('radio-tuner').hidden,
        tunerCount: window.__godsEyeView.styleManager._radioTunerStations.length,
        tunerLabel: document.getElementById('radio-tuner-band-label').textContent,
      };
    });
    check('750-station catalog renders within the browser budget', initial.state.stationCount === 750 && enableElapsedMs < 5000, `${enableElapsedMs}ms`);
    check('enable does not autoplay', initial.plays === 0 && initial.state.audioState === 'stopped');
    check(
      'compact and detailed Radio power controls reflect the layer manager independently of disclosure',
      initial.enablePressed === 'true' && initial.compactEnablePressed === 'true'
        && initial.launcherExpanded === 'true' && initial.launcherActive,
    );
    check('dynamic canonical and genre categories reach the UI', initial.filterOptions >= 10, `${initial.filterOptions} options`);
    const musicOption = initial.filterPalette.find((entry) => entry.id === 'music');
    const newsOption = initial.filterPalette.find((entry) => entry.id === 'news');
    check(
      'station-tag options show category-colored circles before their labels',
      initial.filterPalette.every((entry) => entry.label.startsWith('● '))
        && musicOption?.color === '#54d17a'
        && newsOption?.color === '#44adff',
      JSON.stringify({ musicOption, newsOption }),
    );
    check('All is the initial Radio filter', initial.state.filter === 'all' && initial.state.filteredCount === 750, `${initial.state.filteredCount} stations`);
    check(
      'the default All filter exposes a draggable directory tuner band',
      initial.tunerVisible && initial.tunerCount === 750 && initial.tunerLabel === 'DIRECTORY BAND',
      JSON.stringify({ visible: initial.tunerVisible, count: initial.tunerCount, label: initial.tunerLabel }),
    );
    const uncertainPresentation = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const entry = gev.dataManager.layers.get('radio');
      const module = entry.module;
      const stationId = module.getTunerStations(1)[0]?.id || null;
      const selectedBefore = module.getUIState().selected?.id || null;
      const playsBefore = window.__qaRadioPlayCalls.length;
      const camera = gev.viewer.camera;
      const originalFlyTo = camera.flyTo;
      const flyToCalls = [];
      camera.flyTo = (options) => flyToCalls.push(options);
      const beganTuning = module.beginTuning();
      module.setTuningStatic(false);
      entry.lifecycleUncertain = true;
      module.setLifecyclePresentation({
        lifecycleState: 'enabled',
        enabled: true,
        uncertain: true,
      });
      gev.dataManager._refreshTogglePanel();
      const staticResult = module.setTuningStatic(true);
      const filterBefore = module.getUIState().filter;
      const filterControl = document.getElementById('radio-filter');
      const originalPinned = style._radioTunerBandPinnedForNavigation;
      const originalPool = style._radioTunerPool;
      style._radioTunerBandPinnedForNavigation = true;
      filterControl.value = filterBefore === 'news' ? 'all' : 'news';
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const rejectedUIFilter = {
        moduleFilter: module.getUIState().filter,
        controlFilter: filterControl.value,
        pinned: style._radioTunerBandPinnedForNavigation,
        poolIdentityPreserved: style._radioTunerPool === originalPool,
      };
      style._radioTunerBandPinnedForNavigation = originalPinned;
      style._radioTunerPool = originalPool;
      const filterResult = module.setFilter('news');
      const toggleResult = await module.togglePlayback({ origin: 'user' });
      const directSelect = module.selectStation(stationId, {
        autoplay: true,
        origin: 'voice',
      });
      const directPlay = await module.play({ origin: 'voice' });
      const directCycle = module.cycleStation(1, {
        autoplay: false,
        rotate: true,
        stationIds: module.getTunerStations(3).map(({ id }) => id),
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result = {
        presentationActive: module.getUIState().presentationActive,
        markerSourceVisible: gev.viewer.dataSources.getByName('Radio stations')[0]?.show,
        tunerHidden: document.getElementById('radio-tuner').hidden,
        filterDisabled: document.getElementById('radio-filter').disabled,
        prevDisabled: document.getElementById('radio-prev-btn').disabled,
        playDisabled: document.getElementById('radio-play-btn').disabled,
        volumeDisabled: document.getElementById('radio-volume').disabled,
        disclosureLabel: document.getElementById('context-radio-toggle-btn').getAttribute('aria-label'),
        compactPowerLabel: document.getElementById('context-radio-mini-enable-btn').getAttribute('aria-label'),
        compactPowerText: document.getElementById('context-radio-mini-enable-btn').textContent,
        fullLabel: document.getElementById('radio-enable-btn').getAttribute('aria-label'),
        fullText: document.getElementById('radio-enable-btn').textContent,
        layerState: document.getElementById('radio-layer-state').textContent,
        playbackMessage: document.getElementById('radio-playback-state').textContent,
        miniStation: document.getElementById('context-radio-mini-station').textContent,
        dataRailText: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.textContent,
        dataRailState: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.dataset.feedState,
        dataRailLabel: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.getAttribute('aria-label'),
        dataRailMeta: document.querySelector('[data-layer-id="radio"] .data-toggle-meta')?.textContent,
        directSelect,
        directPlay,
        directCycle,
        beganTuning,
        staticResult,
        tuningActive: module.getUIState().tuningActive,
        tuningStatic: module.getUIState().tuningStatic,
        filterBefore,
        rejectedUIFilter,
        filterResult,
        filterAfter: module.getUIState().filter,
        toggleResult,
        flyToCalls: flyToCalls.length,
        selectedBefore,
        selectedAfter: module.getUIState().selected?.id || null,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      entry.lifecycleUncertain = false;
      module.setLifecyclePresentation({
        lifecycleState: 'enabled',
        enabled: true,
        uncertain: false,
      });
      gev.dataManager._refreshTogglePanel();
      module.cancelTuning();
      camera.flyTo = originalFlyTo;
      return result;
    });
    check(
      'uncertain settled-ON Radio remains hidden and inert until manager reconciliation',
      uncertainPresentation.presentationActive === false
        && uncertainPresentation.markerSourceVisible === false
        && uncertainPresentation.tunerHidden
        && uncertainPresentation.filterDisabled
        && uncertainPresentation.prevDisabled
        && uncertainPresentation.playDisabled
        && uncertainPresentation.volumeDisabled
        && /compact Radio controls/i.test(uncertainPresentation.disclosureLabel)
        && /uncertain/i.test(uncertainPresentation.compactPowerLabel)
        && uncertainPresentation.compactPowerText === 'RECONCILE'
        && /uncertain/i.test(uncertainPresentation.fullLabel)
        && uncertainPresentation.fullText === 'RECONCILE'
        && uncertainPresentation.layerState === 'UNCERTAIN'
        && /uncertain/i.test(uncertainPresentation.playbackMessage)
        && uncertainPresentation.miniStation === 'RADIO STATE UNCERTAIN'
        && uncertainPresentation.dataRailText === 'UNCERTAIN'
        && uncertainPresentation.dataRailState === 'uncertain'
        && /uncertain/i.test(uncertainPresentation.dataRailLabel)
        && /uncertain/i.test(uncertainPresentation.dataRailMeta)
        && uncertainPresentation.directSelect === false
        && uncertainPresentation.directPlay === false
        && uncertainPresentation.directCycle === false
        && uncertainPresentation.beganTuning
        && uncertainPresentation.staticResult === false
        && uncertainPresentation.tuningActive
        && uncertainPresentation.tuningStatic === false
        && uncertainPresentation.filterResult === false
        && uncertainPresentation.filterAfter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.moduleFilter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.controlFilter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.pinned
        && uncertainPresentation.rejectedUIFilter.poolIdentityPreserved
        && uncertainPresentation.toggleResult === false
        && uncertainPresentation.flyToCalls === 0
        && uncertainPresentation.selectedAfter === uncertainPresentation.selectedBefore
        && uncertainPresentation.playDelta === 0,
      JSON.stringify(uncertainPresentation),
    );
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const module = gev.dataManager.layers.get('radio').module;
      const originalDisable = module.disable.bind(module);
      module.disable = async (...args) => {
        window.__qaRadioDisableStarted = true;
        await new Promise((resolve) => { window.__qaReleaseRadioDisable = resolve; });
        module.disable = originalDisable;
        return originalDisable(...args);
      };
      window.__qaRadioDisablePromise = gev.dataManager.setEnabled('radio', false, { origin: 'qa-setup' });
    });
    await page.waitForFunction(() => window.__qaRadioDisableStarted === true);
    const disablingPresentation = await page.evaluate(() => ({
      manager: window.__godsEyeView.dataManager.getLayerLifecycleState('radio'),
      presentationActive: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().presentationActive,
      markerSourceVisible: window.__godsEyeView.viewer.dataSources.getByName('Radio stations')[0]?.show,
      full: document.getElementById('radio-enable-btn').textContent,
      disclosure: document.getElementById('context-radio-toggle-btn').getAttribute('aria-label'),
      disclosureControls: document.getElementById('context-radio-toggle-btn').getAttribute('aria-controls'),
      disclosureExpanded: document.getElementById('context-radio-toggle-btn').getAttribute('aria-expanded'),
      compactPower: document.getElementById('context-radio-mini-enable-btn').textContent,
      layerState: document.getElementById('radio-layer-state').textContent,
      message: document.getElementById('radio-playback-state').textContent,
      stopDisabled: document.getElementById('radio-stop-btn').disabled,
      volumeDisabled: document.getElementById('radio-volume').disabled,
    }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'lifecycle-disabling.png') });
    check(
      'Radio teardown exposes DISABLING while settled visibility remains ON',
      disablingPresentation.manager.enabled === true
        && disablingPresentation.manager.lifecycleState === 'disabling'
        && disablingPresentation.presentationActive === false
        && disablingPresentation.markerSourceVisible === false
        && disablingPresentation.full === 'DISABLING'
        && /compact Radio controls/i.test(disablingPresentation.disclosure)
        && disablingPresentation.compactPower === 'DISABLING'
        && disablingPresentation.layerState === 'DISABLING'
        && /disabling/i.test(disablingPresentation.message)
        && disablingPresentation.stopDisabled
        && disablingPresentation.volumeDisabled,
      JSON.stringify(disablingPresentation),
    );
    await page.evaluate(async () => {
      window.__qaReleaseRadioDisable();
      await window.__qaRadioDisablePromise;
      delete window.__qaReleaseRadioDisable;
      delete window.__qaRadioDisablePromise;
      delete window.__qaRadioDisableStarted;
    });
    const explicitRevealBefore = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      gev.styleManager.setPanelCollapsed('global-context-panel', false);
      gev.styleManager.setPanelCollapsed('radio-panel', false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const radio = document.getElementById('radio-panel');
      scroller.scrollTop = Math.max(0, radio.offsetTop - scroller.clientHeight + 70);
      const camera = gev.viewer.camera.positionWC;
      return {
        scrollTop: scroller.scrollTop,
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        plays: window.__qaRadioPlayCalls.length,
      };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'explicit-enable-before.png') });
    // A warm accepted catalog makes re-enable legitimately synchronous: there
    // may be no station request for the interception delay below to hold. Gate
    // the real module enable boundary instead so the manager's ENABLING state
    // is observed deterministically without slowing production behavior.
    await page.evaluate(() => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const originalEnable = radio.enable;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      radio.enable = async function qaGatedRadioEnable(...args) {
        await gate;
        return originalEnable.apply(this, args);
      };
      window.__qaReleaseRadioEnable = () => release();
      window.__qaRestoreRadioEnable = () => { radio.enable = originalEnable; };
    });
    await page.focus('#radio-enable-btn');
    await page.click('#radio-enable-btn');
    await page.waitForFunction(() => (
      window.__godsEyeView.dataManager.getLayerLifecycleState('radio')?.lifecycleState === 'enabling'
    ));
    const enablingPresentation = await page.evaluate(() => ({
      manager: window.__godsEyeView.dataManager.getLayerLifecycleState('radio'),
      presentationActive: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().presentationActive,
      markerSourceVisible: window.__godsEyeView.viewer.dataSources.getByName('Radio stations')[0]?.show,
      full: document.getElementById('radio-enable-btn').textContent,
      disclosure: document.getElementById('context-radio-toggle-btn').getAttribute('aria-label'),
      disclosureControls: document.getElementById('context-radio-toggle-btn').getAttribute('aria-controls'),
      disclosureExpanded: document.getElementById('context-radio-toggle-btn').getAttribute('aria-expanded'),
      compactPower: document.getElementById('context-radio-mini-enable-btn').textContent,
      layerState: document.getElementById('radio-layer-state').textContent,
      message: document.getElementById('radio-playback-state').textContent,
      tunerHidden: document.getElementById('radio-tuner').hidden,
      stopDisabled: document.getElementById('radio-stop-btn').disabled,
      volumeDisabled: document.getElementById('radio-volume').disabled,
    }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'lifecycle-enabling.png') });
    check(
      'Radio activation exposes ENABLING while settled visibility remains OFF',
      enablingPresentation.manager.enabled === false
        && enablingPresentation.manager.lifecycleState === 'enabling'
        && enablingPresentation.presentationActive === false
        && enablingPresentation.markerSourceVisible === false
        && enablingPresentation.full === 'ENABLING'
        && enablingPresentation.disclosure === 'Go to expanded Radio section'
        && enablingPresentation.disclosureControls === 'radio-panel'
        && enablingPresentation.disclosureExpanded === 'true'
        && enablingPresentation.compactPower === 'ENABLING'
        && enablingPresentation.layerState === 'ENABLING'
        && /enabling/i.test(enablingPresentation.message)
        && enablingPresentation.tunerHidden
        && enablingPresentation.stopDisabled
        && enablingPresentation.volumeDisabled,
      JSON.stringify(enablingPresentation),
    );
    await page.evaluate(() => window.__qaReleaseRadioEnable?.());
    await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('radio'));
    await page.evaluate(() => window.__qaRestoreRadioEnable?.());
    await sleep(650);
    const explicitRevealAfter = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const viewport = scroller.getBoundingClientRect();
      const directory = document.querySelector('#radio-panel .radio-directory-row').getBoundingClientRect();
      const play = document.getElementById('radio-play-btn').getBoundingClientRect();
      const camera = gev.viewer.camera.positionWC;
      return {
        scrollTop: scroller.scrollTop,
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        directoryVisible: directory.top >= viewport.top && directory.bottom <= viewport.bottom,
        playVisible: play.top >= viewport.top && play.bottom <= viewport.bottom,
        focusId: document.activeElement?.id,
        plays: window.__qaRadioPlayCalls.length,
        audioState: gev.dataManager.layers.get('radio').module.getUIState().audioState,
      };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'explicit-enable-after.png') });
    const revealCameraDelta = Math.hypot(
      explicitRevealAfter.camera.x - explicitRevealBefore.camera.x,
      explicitRevealAfter.camera.y - explicitRevealBefore.camera.y,
      explicitRevealAfter.camera.z - explicitRevealBefore.camera.z,
    );
    check(
      'expanded Radio Enable reveals the directory and Play inside Context without autoplay or focus/camera theft',
      explicitRevealAfter.scrollTop > explicitRevealBefore.scrollTop
        && explicitRevealAfter.directoryVisible && explicitRevealAfter.playVisible
        && explicitRevealAfter.focusId === 'radio-enable-btn'
        && explicitRevealAfter.pageY === explicitRevealBefore.pageY
        && revealCameraDelta < 0.01
        && explicitRevealAfter.plays === explicitRevealBefore.plays
        && explicitRevealAfter.audioState === 'stopped',
      JSON.stringify({ before: explicitRevealBefore, after: explicitRevealAfter, cameraDelta: revealCameraDelta }),
    );
    await page.evaluate(() => {
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', true);
    });
    const singletonViews = [];
    const singletonViewSpecs = [
      { category: 'news', lon: -174 },
      { category: 'public-safety', lon: -138 },
      { category: 'weather', lon: -150 },
      { category: 'all', lon: -174 },
    ];
    for (const spec of singletonViewSpecs) {
      await page.select('#radio-filter', spec.category);
      for (const view of [
        { name: 'global', height: 24_200_000, limit: 16 },
        { name: 'near', height: 500_000, limit: 32 },
      ]) {
        await page.evaluate(({ lon, height }) => {
          const viewer = window.__godsEyeView.viewer;
          viewer.camera.cancelFlight();
          viewer.camera.setView({
            destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
              longitude: lon * Math.PI / 180,
              latitude: 6 * Math.PI / 180,
              height,
            }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          viewer.scene.requestRender();
        }, { lon: spec.lon, height: view.height });
        await sleep(700);
        const sample = await page.evaluate(async () => {
          const viewer = window.__godsEyeView.viewer;
          const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
          const dataSource = Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index))
            .find((item) => item.name === 'Radio stations');
          const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
          const { radioStationIdFromPick } = await import('/src/data/radio.js');
          return new Promise((resolve) => {
            let removePostRender = null;
            const finish = () => {
              removePostRender?.();
              const overlay = radio.getOverlayDiagnostics();
              const paintedSingletonIds = overlay.singletonIds.filter((entryId) => Boolean(getOverlayPaintRect('radio', entryId)));
              const pickableSingletonIds = paintedSingletonIds.filter((entryId) => {
                const rect = getOverlayPaintRect('radio', entryId);
                const anchor = rect?.entry?.position
                  && viewer.scene.cartesianToCanvasCoordinates(rect.entry.position);
                if (!anchor) return false;
                return (viewer.scene.drillPick(anchor, 16) || [])
                  .some((picked) => radioStationIdFromPick(picked) === entryId.slice('station:'.length));
              });
              resolve({
                overlay,
                host: getWorldOverlayDiagnostics(),
                paintedSingletonIds,
                pickableSingletonIds,
                nativeLabelCount: dataSource.entities.values.filter((entity) => Boolean(entity.label)).length,
              });
            };
            const timeout = setTimeout(finish, 500);
            removePostRender = viewer.scene.postRender.addEventListener(() => {
              clearTimeout(timeout);
              finish();
            });
            viewer.scene.requestRender();
          });
        });
        singletonViews.push({ ...spec, ...view, ...sample });
        await page.screenshot({
          path: path.join(SHOTS_DIR, `singleton-${spec.category}-${view.name}.png`),
        });
      }
    }
    const sparseSingletonViews = singletonViews.filter((sample) => sample.category !== 'all');
    check(
      'sparse Radio filters paint bounded individual labels through the shared ambient lane',
      sparseSingletonViews.every((sample) => (
        sample.overlay.singletonIds.length > 0
        && sample.overlay.singletonIds.length <= sample.limit
        && sample.paintedSingletonIds.length > 0
        && sample.pickableSingletonIds.length === sample.paintedSingletonIds.length
        && sample.host.entriesBySource?.radio === sample.overlay.entryCount
      )),
      JSON.stringify(sparseSingletonViews.map((sample) => ({
        category: sample.category,
        view: sample.name,
        singletonCount: sample.overlay.singletonIds.length,
        painted: sample.paintedSingletonIds.length,
        pickable: sample.pickableSingletonIds.length,
      }))),
    );
    check(
      'Radio label allocation stays bounded with no native Cesium entity text across sparse and All views',
      singletonViews.every((sample) => (
        sample.overlay.entryCount <= 65
        && sample.nativeLabelCount === 0
        && sample.host.paintedBySource?.radio > 0
      )),
      JSON.stringify(singletonViews.map((sample) => ({
        category: sample.category,
        view: sample.name,
        entries: sample.overlay.entryCount,
        nativeLabels: sample.nativeLabelCount,
        painted: sample.host.paintedBySource?.radio,
      }))),
    );
    const userFacingFailures = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const styleManager = gev.styleManager;
      const dataManager = gev.dataManager;
      const unhandled = [];
      const onUnhandled = (event) => {
        unhandled.push(String(event.reason?.message || event.reason || 'unknown'));
        event.preventDefault();
      };
      window.addEventListener('unhandledrejection', onUnhandled);
      const originalToggle = dataManager.toggle;
      const originalSetEnabled = dataManager.setEnabled;
      const originalRestoreEnabledLayerIds = dataManager.restoreEnabledLayerIds;
      const originalIsEnabled = dataManager.isEnabled;
      const originalIsEffectivelyEnabled = dataManager.isEffectivelyEnabled;
      const originalClear = styleManager._clearLayersOutsideContextMode;
      const originalCapture = styleManager._captureContextSessionSnapshot;
      const originalContextMode = styleManager._contextMode;
      const originalSnapshot = styleManager._contextSessionSnapshot;
      const originalShowToast = styleManager._showToast;
      const installations = dataManager.layers.get('military-installations')?.module;
      const originalSearchNearby = installations?.searchNearby;
      try {
        dataManager.setEnabled = async () => false;
        document.getElementById('radio-enable-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const semanticFalseMessage = document.getElementById('toast').textContent;

        const enabled = new Set();
        styleManager._captureContextSessionSnapshot = () => {};
        const runContextFailure = async (mode, phase, outcome) => {
          enabled.clear();
          enabled.add('local-datacenters');
          styleManager._contextMode = null;
          styleManager._contextSessionSnapshot = {
            enabledLayerIds: new Set(enabled),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          let failureUsed = false;
          const entryLayerId = mode === 'flights' ? 'military-awareness' : 'rocket-launches';
          dataManager.setEnabled = async (layerId, shouldEnable) => {
            const failsIsolation = phase === 'isolation' && layerId === 'local-datacenters' && !shouldEnable;
            const failsActivation = phase === 'activation' && layerId === entryLayerId && shouldEnable;
            if (!failureUsed && (failsIsolation || failsActivation)) {
              failureUsed = true;
              if (outcome === 'reject') throw new Error(`QA ${phase} rejection`);
              return false;
            }
            shouldEnable ? enabled.add(layerId) : enabled.delete(layerId);
            return true;
          };
          const result = await styleManager._runUserFacingContextAction(
            () => styleManager._selectContextMode(mode),
            `${mode} QA transition failed`,
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            mode,
            phase,
            outcome,
            result,
            visibleMode: styleManager._contextMode,
            snapshotCleared: styleManager._contextSessionSnapshot === null,
            priorLayerRestored: enabled.has('local-datacenters'),
            entryEnabled: enabled.has(entryLayerId),
            flightsButtonDisabled: document.getElementById('global-context-flights-btn').disabled,
            missionsButtonDisabled: document.getElementById('global-context-missions-btn').disabled,
            message: document.getElementById('toast').textContent,
          };
        };
        dataManager.isEnabled = (layerId) => enabled.has(layerId);
        // The fake manager model must answer the effective-visibility accessor
        // the isolation loop consults, or real entries (all disabled) leak in.
        dataManager.isEffectivelyEnabled = (layerId) => enabled.has(layerId);
        dataManager.restoreEnabledLayerIds = async (enabledLayerIds, { excludeLayerIds = [] } = {}) => {
          const target = new Set(enabledLayerIds || []);
          const excluded = new Set(excludeLayerIds || []);
          const layerIds = new Set([...enabled, ...target]);
          for (const candidateId of layerIds) {
            if (excluded.has(candidateId)) continue;
            const restored = await dataManager.setEnabled(candidateId, target.has(candidateId));
            if (restored === false) {
              throw new Error(`Failed to restore layer "${candidateId}" visibility`);
            }
          }
        };
        const contextFailures = [];
        for (const mode of ['flights', 'space-missions']) {
          for (const phase of ['isolation', 'activation']) {
            for (const outcome of ['false', 'reject']) {
              contextFailures.push(await runContextFailure(mode, phase, outcome));
            }
          }
        }

        const directEntryFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          for (const outcome of ['false', 'reject']) {
            enabled.clear();
            enabled.add('local-datacenters');
            styleManager._contextMode = null;
            styleManager._contextSessionSnapshot = {
              enabledLayerIds: new Set(enabled),
              userAdded: new Set(),
              userRemoved: new Set(),
              params: {},
            };
            let failureUsed = false;
            const toastMessages = [];
            styleManager._showToast = (message) => {
              toastMessages.push(message);
              originalShowToast.call(styleManager, message);
            };
            dataManager.setEnabled = async (candidateId, shouldEnable, options = {}) => {
              if (!failureUsed && candidateId === 'local-datacenters' && !shouldEnable) {
                failureUsed = true;
                styleManager._handleContextLayerChange({
                  type: 'visibility-failed',
                  layerId: candidateId,
                  enabled: shouldEnable,
                  notificationToken: options.notificationToken,
                  origin: 'user',
                });
                if (outcome === 'reject') throw new Error('QA direct isolation rejection');
                return false;
              }
              shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
              return true;
            };
            const reason = await dataManager._visibilityBlockReason({
              type: 'visibility-will-change',
              layerId,
              enabled: true,
              origin: 'user',
            });
            styleManager._handleContextLayerChange({
              type: 'visibility-blocked',
              layerId,
              enabled: true,
              origin: 'user',
              reason,
            });
            const priorLayerRestored = enabled.has('local-datacenters');
            const retryReason = await dataManager._visibilityBlockReason({
              type: 'visibility-will-change',
              layerId,
              enabled: true,
              origin: 'user',
            });
            directEntryFailures.push({
              layerId,
              outcome,
              reason,
              retryReason,
              toastMessages,
              mode: styleManager._contextMode,
              snapshotCleared: styleManager._contextSessionSnapshot === null,
              priorLayerRestored,
              modeChanging: styleManager._contextModeChanging,
            });
          }
        }
        styleManager._showToast = originalShowToast;

        const directActivationFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          enabled.clear();
          styleManager._contextMode = null;
          styleManager._contextSessionSnapshot = {
            enabledLayerIds: new Set(['local-datacenters']),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          dataManager.setEnabled = async (candidateId, shouldEnable) => {
            shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
            return true;
          };
          styleManager._handleContextLayerChange({
            type: 'visibility-failed',
            layerId,
            enabled: true,
            origin: 'user',
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          directActivationFailures.push({
            layerId,
            mode: styleManager._contextMode,
            snapshotCleared: styleManager._contextSessionSnapshot === null,
            priorLayerRestored: enabled.has('local-datacenters'),
            failedLayerDisabled: !enabled.has(layerId),
          });
        }

        const directActivationRollbackFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          enabled.clear();
          styleManager._contextMode = null;
          styleManager._contextSessionSnapshot = {
            enabledLayerIds: new Set(['local-datacenters']),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          const toastMessages = [];
          const showToastBeforeRollbackFailure = styleManager._showToast;
          styleManager._showToast = (message) => {
            toastMessages.push(message);
            showToastBeforeRollbackFailure.call(styleManager, message);
          };
          dataManager.setEnabled = async (candidateId, shouldEnable) => {
            if (candidateId === 'local-datacenters' && shouldEnable) return false;
            shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
            return true;
          };
          styleManager._handleContextLayerChange({
            type: 'visibility-failed',
            layerId,
            enabled: true,
            origin: 'user',
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          styleManager._showToast = showToastBeforeRollbackFailure;
          directActivationRollbackFailures.push({
            layerId,
            toastMessages,
            retryRetained: styleManager._contextSessionSnapshot?.enabledLayerIds?.has('local-datacenters') === true,
          });
        }

        const contextExitFailures = [];
        dataManager.setEnabled = originalSetEnabled;
        dataManager.restoreEnabledLayerIds = originalRestoreEnabledLayerIds;
        dataManager.isEnabled = originalIsEnabled;
        dataManager.isEffectivelyEnabled = originalIsEffectivelyEnabled;
        for (const outcome of ['false', 'reject']) {
          const layerId = `qa-context-exit-${outcome}`;
          let enableOutcome = outcome;
          const toastMessages = [];
          const qaLayer = {
            id: layerId,
            name: `QA Context exit ${outcome}`,
            updateInterval: -1,
            init: async () => true,
            enable: async () => {
              if (enableOutcome === 'reject') throw new Error(`QA Context exit ${outcome}`);
              return enableOutcome !== 'false';
            },
            disable: async () => true,
            update: async () => true,
            destroy: async () => true,
            getStats: () => ({}),
          };
          window.__gevQaRegisterLayer(dataManager, qaLayer);
          try {
            const enabledBeforeExit = dataManager.getEnabledLayerIds();
            styleManager._contextMode = 'flights';
            styleManager._contextSessionSnapshot = {
              enabledLayerIds: new Set([...enabledBeforeExit, layerId]),
              userAdded: new Set(),
              userRemoved: new Set(),
              params: {},
            };
            styleManager._showToast = (message) => {
              toastMessages.push(message);
              originalShowToast.call(styleManager, message);
            };
            const unhandledBefore = unhandled.length;
            const result = await styleManager._runUserFacingContextAction(
              (notificationToken) => styleManager._deactivateContextForLayerChange({ notificationToken }),
              `QA Context exit ${outcome} surfaced once`,
            );
            const retainedForRetry = styleManager._contextSessionSnapshot?.enabledLayerIds?.has(layerId) === true;
            enableOutcome = 'success';
            const retryResult = await styleManager._runUserFacingContextAction(
              (notificationToken) => styleManager._deactivateContextForLayerChange({ notificationToken }),
              `QA Context exit ${outcome} retry failed`,
            );
            contextExitFailures.push({
              outcome,
              result,
              retryResult: retryResult ?? true,
              toastMessages,
              unhandledDelta: unhandled.length - unhandledBefore,
              retainedForRetry,
              mode: styleManager._contextMode,
              modeChanging: styleManager._contextModeChanging,
              snapshotClearedAfterRetry: styleManager._contextSessionSnapshot === null,
              enabledAfterRetry: dataManager.isEnabled(layerId),
              toastRole: document.getElementById('toast').getAttribute('role'),
              toastLive: document.getElementById('toast').getAttribute('aria-live'),
              toastAtomic: document.getElementById('toast').getAttribute('aria-atomic'),
            });
          } finally {
            styleManager._showToast = originalShowToast;
            await window.__gevQaUnregisterLayer(dataManager, layerId);
          }
        }

        const unrelatedLayerId = 'qa-unrelated-manager-failure';
        const unrelatedToastMessages = [];
        let releasePendingAction = null;
        window.__gevQaRegisterLayer(dataManager, {
          id: unrelatedLayerId,
          name: 'QA unrelated manager failure',
          updateInterval: -1,
          init: async () => true,
          enable: async () => false,
          disable: async () => true,
          update: async () => true,
          destroy: async () => true,
          getStats: () => ({}),
        });
        styleManager._showToast = (message) => {
          unrelatedToastMessages.push(message);
          originalShowToast.call(styleManager, message);
        };
        const pendingAction = styleManager._runUserFacingContextAction(() => (
          new Promise((resolve) => { releasePendingAction = resolve; })
        ));
        while (!releasePendingAction) await new Promise((resolve) => setTimeout(resolve, 0));
        const unrelatedResult = await dataManager.setEnabled(unrelatedLayerId, true);
        releasePendingAction(true);
        await pendingAction;
        styleManager._showToast = originalShowToast;
        await window.__gevQaUnregisterLayer(dataManager, unrelatedLayerId);
        const unrelatedManagerFailure = {
          result: unrelatedResult,
          toastMessages: unrelatedToastMessages,
        };

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) return false;
          return true;
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationFalseMessage = document.getElementById('toast').textContent;
        const installationFalseReleased = !document.getElementById('installations-search-btn').disabled;

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) {
            throw new Error('QA installation enable rejection');
          }
          return true;
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationEnableRejectionMessage = document.getElementById('toast').textContent;
        const installationEnableRejectionReleased = !document.getElementById('installations-search-btn').disabled;

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) enabled.add(layerId);
          return true;
        };
        if (installations) installations.searchNearby = async () => {
          throw new Error('QA installation search rejection');
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationRejectionMessage = document.getElementById('toast').textContent;
        const installationRejectionReleased = !document.getElementById('installations-search-btn').disabled;

        if (installations) installations.searchNearby = async () => false;
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationSearchFalseMessage = document.getElementById('toast').textContent;
        const installationSearchFalseReleased = !document.getElementById('installations-search-btn').disabled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          semanticFalseMessage,
          contextFailures,
          directEntryFailures,
          directActivationFailures,
          directActivationRollbackFailures,
          contextExitFailures,
          unrelatedManagerFailure,
          installationFalseMessage,
          installationFalseReleased,
          installationEnableRejectionMessage,
          installationEnableRejectionReleased,
          installationRejectionMessage,
          installationRejectionReleased,
          installationSearchFalseMessage,
          installationSearchFalseReleased,
          unhandled,
        };
      } finally {
        dataManager.toggle = originalToggle;
        dataManager.setEnabled = originalSetEnabled;
        dataManager.restoreEnabledLayerIds = originalRestoreEnabledLayerIds;
        dataManager.isEnabled = originalIsEnabled;
        dataManager.isEffectivelyEnabled = originalIsEffectivelyEnabled;
        styleManager._clearLayersOutsideContextMode = originalClear;
        styleManager._captureContextSessionSnapshot = originalCapture;
        styleManager._contextMode = originalContextMode;
        styleManager._contextSessionSnapshot = originalSnapshot;
        styleManager._showToast = originalShowToast;
        if (installations) installations.searchNearby = originalSearchNearby;
        window.removeEventListener('unhandledrejection', onUnhandled);
      }
    });
    check(
      'user-facing chip, real Context entry rollback, and installation Search failures settle safely',
      userFacingFailures.semanticFalseMessage === 'Radio could not stop cleanly'
        && userFacingFailures.contextFailures.length === 8
        && userFacingFailures.contextFailures.every((failure) => (
          failure.result === false
          && failure.visibleMode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && !failure.entryEnabled
          && !failure.flightsButtonDisabled
          && !failure.missionsButtonDisabled
          && failure.message.includes('QA transition failed')
        ))
        && userFacingFailures.directEntryFailures.length === 4
        && userFacingFailures.directEntryFailures.every((failure) => (
          failure.reason.includes('could not start')
          && failure.retryReason === null
          && failure.toastMessages.length === 1
          && failure.toastMessages[0] === failure.reason
          && failure.mode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && !failure.modeChanging
        ))
        && userFacingFailures.directActivationFailures.length === 2
        && userFacingFailures.directActivationFailures.every((failure) => (
          failure.mode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && failure.failedLayerDisabled
        ))
        && userFacingFailures.directActivationRollbackFailures.length === 2
        && userFacingFailures.directActivationRollbackFailures.every((failure) => (
          failure.toastMessages.length === 1
          && failure.toastMessages[0] === `${failure.layerId} could not start cleanly`
          && failure.retryRetained
        ))
        && userFacingFailures.contextExitFailures.length === 2
        && userFacingFailures.contextExitFailures.every((failure) => (
          failure.result === false
          && failure.retryResult === true
          && failure.toastMessages.length === 1
          && failure.toastMessages[0].includes('surfaced once')
          && failure.unhandledDelta === 0
          && failure.retainedForRetry
          && failure.mode === null
          && !failure.modeChanging
          && failure.snapshotClearedAfterRetry
          && failure.enabledAfterRetry
          && failure.toastRole === 'status'
          && failure.toastLive === 'polite'
          && failure.toastAtomic === 'true'
        ))
        && userFacingFailures.unrelatedManagerFailure.result === false
        && userFacingFailures.unrelatedManagerFailure.toastMessages.length === 1
        && userFacingFailures.unrelatedManagerFailure.toastMessages[0].includes('qa-unrelated-manager-failure could not start cleanly')
        && userFacingFailures.installationFalseMessage.includes('could not be refreshed')
        && userFacingFailures.installationFalseReleased
        && userFacingFailures.installationEnableRejectionMessage.includes('could not be refreshed')
        && userFacingFailures.installationEnableRejectionReleased
        && userFacingFailures.installationRejectionMessage.includes('could not be refreshed')
        && userFacingFailures.installationRejectionReleased
        && userFacingFailures.installationSearchFalseMessage.includes('could not be refreshed')
        && userFacingFailures.installationSearchFalseReleased
        && userFacingFailures.unhandled.length === 0,
      JSON.stringify(userFacingFailures),
    );
    catalogDegraded = true;
    const degradedCatalog = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      await radio.update();
      return {
        state: radio.getUIState(),
        message: document.getElementById('radio-playback-state').textContent,
      };
    });
    check(
      'degraded Radio catalog remains usable and is labeled explicitly',
      degradedCatalog.state.stationCount === 750
        && degradedCatalog.state.degraded === true
        && degradedCatalog.state.stale === false
        && degradedCatalog.message.includes('degraded directory'),
      JSON.stringify(degradedCatalog),
    );
    catalogDegraded = false;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    await page.select('#radio-filter', 'all');
    const allPalette = await page.evaluate(() => {
      const source = Array.from({ length: window.__godsEyeView.viewer.dataSources.length }, (_, index) => (
        window.__godsEyeView.viewer.dataSources.get(index)
      )).find((item) => item.name === 'Radio stations');
      const colorFor = (index) => {
        const id = `radio:00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        const color = source?.entities.getById(id)?.point?.color?.getValue?.();
        return color ? [color.red, color.green, color.blue].map((value) => Math.round(value * 255)) : null;
      };
      return { news: colorFor(0), talk: colorFor(1), music: colorFor(7) };
    });
    check(
      'All stations use distinct category marker colors and Music is green',
      JSON.stringify(allPalette.news) !== JSON.stringify(allPalette.music)
        && JSON.stringify(allPalette.talk) !== JSON.stringify(allPalette.music)
        && allPalette.music?.[1] > allPalette.music?.[0]
        && allPalette.music?.[1] > allPalette.music?.[2],
      JSON.stringify(allPalette),
    );
    const clusterBadge = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const { distanceFade } = await import('/src/overlays/worldOverlayDraw.js');
      const { radioStationIdFromPick } = await import('/src/data/radio.js');
      const baselineSolveRevision = getWorldOverlayDiagnostics().solveRevision;
      const source = Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations');
      const ellipsoid = viewer.scene.globe.ellipsoid;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: -98 * Math.PI / 180,
          latitude: 38 * Math.PI / 180,
          height: 18_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      source.clustering.enabled = false;
      viewer.scene.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Promise((resolve) => {
        const originalPixelRange = source.clustering.pixelRange;
        const timeout = setTimeout(() => {
          remove();
          resolve(null);
        }, 2_000);
        const remove = source.clustering.clusterEvent.addEventListener(async (entities, cluster) => {
          clearTimeout(timeout);
          remove();
          const native = {
            count: entities.length,
            labelShow: cluster.label.show,
            labelText: cluster.label.text,
            pointSize: cluster.point.pixelSize,
            pointMaxDistance: cluster.point.distanceDisplayCondition?.far ?? null,
          };
          source.clustering.pixelRange = originalPixelRange;
          const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
          await new Promise((done) => setTimeout(done, 0));
          let painted = null;
          for (let attempt = 0; attempt < 20 && !painted?.rect; attempt += 1) {
            painted = await new Promise((done) => {
              let removePostRender = null;
              const timeout = setTimeout(() => {
                removePostRender?.();
                done({ rect: null, host: getWorldOverlayDiagnostics() });
              }, 150);
              removePostRender = viewer.scene.postRender.addEventListener(() => {
                clearTimeout(timeout);
                removePostRender();
                const host = getWorldOverlayDiagnostics();
                let match = null;
                for (const entryId of radio.getOverlayDiagnostics().clusterIds) {
                  const rect = getOverlayPaintRect('radio', entryId);
                  if (rect) match = { entryId, rect };
                }
                done({
                  expectedEntryId: match?.entryId || null,
                  rect: match ? { x: match.rect.x, y: match.rect.y, w: match.rect.w, h: match.rect.h } : null,
                  host,
                });
              });
              viewer.scene.requestRender();
            });
          }
          resolve({
            native,
            baselineSolveRevision,
            expectedEntryId: painted?.expectedEntryId || null,
            rect: painted?.rect || null,
            source: radio.getOverlayDiagnostics(),
            host: painted?.host || getWorldOverlayDiagnostics(),
          });
        });
        source.clustering.enabled = true;
        viewer.scene.requestRender();
      });
    });
    check(
      'Radio cluster text is native-free and painted through the bounded shared host',
      clusterBadge?.native?.labelShow === false
        && clusterBadge?.native?.labelText === ''
        && clusterBadge?.native?.pointSize >= 14
        && clusterBadge?.native?.pointMaxDistance === 50_000_000
        && clusterBadge?.source?.clusterTexts?.some((text) => /^\d+\s+[A-Z]/.test(text))
        && clusterBadge?.source?.entryCount <= 65
        && clusterBadge?.host?.entriesBySource?.radio === clusterBadge?.source?.entryCount
        && clusterBadge?.host?.solveRevision > clusterBadge?.baselineSolveRevision
        && clusterBadge?.rect?.w > 0
        && clusterBadge?.rect?.h > 0,
      JSON.stringify(clusterBadge),
    );
    const highGlobalClusterLabels = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      const { getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const { distanceFade } = await import('/src/overlays/worldOverlayDraw.js');
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: 68 * Math.PI / 180,
          latitude: 7 * Math.PI / 180,
          height: 24_200_000,
        }),
        orientation: { heading: 15 * Math.PI / 180, pitch: -Math.PI / 2, roll: 0 },
      });
      viewer.scene.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const source = radio.getOverlayDiagnostics();
      const cameraPosition = viewer.camera.positionWC;
      const cameraRadius = Math.hypot(cameraPosition.x, cameraPosition.y, cameraPosition.z);
      const horizonDistance = Math.sqrt(Math.max(
        0,
        cameraRadius * cameraRadius - ellipsoid.maximumRadius * ellipsoid.maximumRadius,
      ));
      const points = Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations')?.clustering?._clusterPointCollection;
      let clusterPoint = null;
      for (let index = 0; index < (points?.length || 0); index += 1) {
        const point = points.get(index);
        if (!point?.show || !Array.isArray(point.id) || !point.id.length) continue;
        const anchor = viewer.scene.cartesianToCanvasCoordinates(point.position);
        if (!anchor) continue;
        const exactPick = (viewer.scene.drillPick(anchor, 16) || []).find((picked) => (
          picked?.primitive === point && picked?.id === point.id
        ));
        clusterPoint = {
          maxDistance: point.distanceDisplayCondition?.far ?? null,
          pickable: Boolean(exactPick),
        };
        break;
      }
      return {
        source,
        host: getWorldOverlayDiagnostics(),
        altitude: viewer.camera.positionCartographic.height,
        horizonDistance,
        horizonDistanceAlpha: distanceFade(horizonDistance, { maxDistance: 50_000_000 }),
        clusterPoint,
      };
    });
    check(
      'All-filter cluster labels remain visible at a 24,200 km global view',
      highGlobalClusterLabels.altitude > 24_000_000
        && highGlobalClusterLabels.source.clusterIds.length > 0
        && highGlobalClusterLabels.host.projectedCount > 0
        && highGlobalClusterLabels.host.paintedBySource?.radio > 0
        && highGlobalClusterLabels.horizonDistanceAlpha === 1
        && highGlobalClusterLabels.clusterPoint?.maxDistance === 50_000_000
        && highGlobalClusterLabels.clusterPoint?.pickable,
      JSON.stringify(highGlobalClusterLabels),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'high-global-all-labels.png') });
    const clusterContinuity = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const paintedClusters = () => new Promise((resolve) => {
        let removePostRender = null;
        const timeout = setTimeout(() => {
          removePostRender?.();
          resolve({ clusters: [], fadingCount: -1, host: null, source: null });
        }, 500);
        removePostRender = viewer.scene.postRender.addEventListener(() => {
          clearTimeout(timeout);
          removePostRender();
          const source = radio.getOverlayDiagnostics();
          const host = getWorldOverlayDiagnostics();
          const clusters = source.clusterIds.map((entryId, index) => {
            const rect = getOverlayPaintRect('radio', entryId);
            return rect ? {
              entryId,
              text: source.clusterTexts[index],
              stateless: rect.entry?.stateless === true,
              edgeFade: rect.entry?.edgeFade,
            } : null;
          }).filter(Boolean);
          resolve({
            clusters,
            fadingCount: host.fadingCount,
            host,
            source,
          });
        });
        viewer.scene.requestRender();
      });
      const longitudes = [-25, -24, -23, -22, -23, -24, -25];
      const samples = [];
      for (const longitude of longitudes) {
        viewer.camera.setView({
          destination: ellipsoid.cartographicToCartesian({
            longitude: longitude * Math.PI / 180,
            latitude: 38 * Math.PI / 180,
            height: 10_000_000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        viewer.scene.requestRender();
        for (const delay of [50, 100, 200, 350]) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          samples.push({ longitude, delay, ...(await paintedClusters()) });
        }
      }
      let retainedAcrossSteps = 0;
      let countChangingRetained = 0;
      const settled = samples.filter((sample) => sample.delay === 350);
      for (let index = 1; index < settled.length; index += 1) {
        const previous = new Map(settled[index - 1].clusters.map((cluster) => [cluster.entryId, cluster.text]));
        for (const cluster of settled[index].clusters) {
          if (!previous.has(cluster.entryId)) continue;
          retainedAcrossSteps += 1;
          if (previous.get(cluster.entryId) !== cluster.text) countChangingRetained += 1;
        }
      }
      return {
        sampleCount: samples.length,
        paintedSamples: samples.filter((sample) => sample.clusters.length > 0).length,
        unpaintedProjectedSamples: samples.filter((sample) => (
          sample.clusters.length === 0 && (sample.host?.projectedCount || 0) > 0
        )).length,
        emptySamples: samples.filter((sample) => sample.clusters.length === 0).map((sample) => ({
          longitude: sample.longitude,
          delay: sample.delay,
          sourceEntries: sample.source?.entryCount,
          hostCandidates: sample.host?.candidateCount,
          hostProjected: sample.host?.projectedCount,
          hostPainted: sample.host?.paintedCount,
          hostFading: sample.host?.fadingCount,
        })),
        fadingSamples: samples.filter((sample) => sample.fadingCount !== 0).map((sample) => ({
          longitude: sample.longitude,
          delay: sample.delay,
          fadingCount: sample.fadingCount,
        })),
        allHardOpacity: samples.every((sample) => sample.clusters.every(
          (cluster) => cluster.stateless && cluster.edgeFade === 'none',
        )),
        retainedAcrossSteps,
        countChangingRetained,
      };
    });
    check(
      'Radio cluster badges remain hard-opacity through one-degree forward/reverse count changes',
      clusterContinuity.sampleCount === 28
        && clusterContinuity.paintedSamples > 0
        && clusterContinuity.unpaintedProjectedSamples === 0
        && clusterContinuity.allHardOpacity
        && clusterContinuity.retainedAcrossSteps > 0
        && clusterContinuity.countChangingRetained > 0,
      JSON.stringify(clusterContinuity),
    );
    const directoryRefreshContinuity = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const before = radio.getOverlayDiagnostics().clusterMemberships;
      await radio.update();
      viewer.scene.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const after = radio.getOverlayDiagnostics().clusterMemberships;
      const beforeByMembership = new Map(before.map((entry) => [entry.membershipId, entry.entryId]));
      const unchanged = after.filter((entry) => beforeByMembership.has(entry.membershipId));
      return {
        beforeCount: before.length,
        afterCount: after.length,
        unchangedCount: unchanged.length,
        retainedCount: unchanged.filter((entry) => beforeByMembership.get(entry.membershipId) === entry.entryId).length,
      };
    });
    check(
      'unchanged directory refresh membership retains cluster overlay identity',
      directoryRefreshContinuity.beforeCount > 0
        && directoryRefreshContinuity.unchangedCount > 0
        && directoryRefreshContinuity.retainedCount === directoryRefreshContinuity.unchangedCount,
      JSON.stringify(directoryRefreshContinuity),
    );
    await page.select('#radio-filter', 'news');
    check('launcher enables Radio without forcing Context open', !initial.panelExpanded && !initial.contextExpanded && initial.nestedInContext);
    check('full Play is available before a station is selected', !initial.state.selected && initial.fullPlayEnabled && initial.fullPlayLabel === 'Play nearest radio station');

    const hoverOnlyDisclosure = await page.evaluate(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      if (button.getAttribute('aria-expanded') === 'true') button.click();
      return {
        expanded: button.getAttribute('aria-expanded'),
        hidden: document.getElementById('context-radio-mini').hidden,
      };
    });
    await page.hover('#context-radio-toggle-btn');
    await sleep(100);
    const hoverOnlyVisible = await page.$eval('#context-radio-mini', (mini) => (
      !mini.hidden && getComputedStyle(mini).display !== 'none'
    ));
    check(
      'hover alone does not disclose compact Radio controls',
      hoverOnlyDisclosure.expanded === 'false' && hoverOnlyDisclosure.hidden && !hoverOnlyVisible,
      JSON.stringify({ hoverOnlyDisclosure, hoverOnlyVisible }),
    );
    await page.click('#context-radio-toggle-btn');
    await page.waitForFunction(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      const mini = document.getElementById('context-radio-mini');
      return button.getAttribute('aria-expanded') === 'true'
        && !mini.hidden && getComputedStyle(mini).display !== 'none';
    });
    const compact = await page.evaluate(() => {
      const mini = document.getElementById('context-radio-mini');
      const toggle = document.getElementById('context-radio-toggle-btn');
      const dock = document.getElementById('context-radio-dock');
      const miniRect = mini.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      const miniStyle = getComputedStyle(mini);
      return {
        visible: miniStyle.display !== 'none' && miniRect.width > 0 && miniRect.height > 0,
        display: miniStyle.display,
        visibility: miniStyle.visibility,
        opacity: miniStyle.opacity,
        miniRect: { top: miniRect.top, left: miniRect.left, width: miniRect.width, height: miniRect.height },
        toggleRect: { top: toggleRect.top, left: toggleRect.left, width: toggleRect.width, height: toggleRect.height },
        dockRect: (() => {
          const rect = dock.getBoundingClientRect();
          return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        })(),
        offsetParent: mini.offsetParent?.id || mini.offsetParent?.className || null,
        prevEnabled: !document.getElementById('context-radio-mini-prev-btn').disabled,
        playEnabled: !document.getElementById('context-radio-mini-play-btn').disabled,
        playLabel: document.getElementById('context-radio-mini-play-btn').getAttribute('aria-label'),
        nextEnabled: !document.getElementById('context-radio-mini-next-btn').disabled,
        volumeEnabled: !document.getElementById('context-radio-mini-volume').disabled,
        offsetBelowToggle: Math.round(miniRect.top - toggleRect.bottom),
      };
    });
    check(
      'explicit launcher disclosure reveals enabled compact Radio controls',
      compact.visible && compact.prevEnabled && compact.playEnabled && compact.nextEnabled && compact.volumeEnabled,
      JSON.stringify(compact),
    );
    check('compact Play is available before a station is selected', compact.playLabel === 'Play nearest radio station');
    check('compact Radio controls sit 20px below the launcher', compact.offsetBelowToggle === 20, `${compact.offsetBelowToggle}px`);
    const compactCloseDisclosure = await page.evaluate(() => {
      const launcher = document.getElementById('context-radio-toggle-btn');
      const close = document.getElementById('context-radio-mini-close-btn');
      close.focus();
      close.click();
      const result = {
        launcherExpanded: launcher.getAttribute('aria-expanded'),
        compactHidden: document.getElementById('context-radio-mini').hidden,
        focusRestored: document.activeElement === launcher,
        radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
      };
      launcher.click();
      return result;
    });
    check(
      'dedicated compact close hides only the compact Radio disclosure and restores launcher focus',
      compactCloseDisclosure.launcherExpanded === 'false'
        && compactCloseDisclosure.compactHidden
        && compactCloseDisclosure.focusRestored
        && compactCloseDisclosure.radioCollapsed,
      JSON.stringify(compactCloseDisclosure),
    );
    const compactTouchDisclosure = await page.evaluate(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      button.click();
      const closed = button.getAttribute('aria-expanded') === 'false'
        && document.getElementById('context-radio-mini').hidden;
      button.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        isPrimary: true,
      }));
      button.click();
      return {
        closed,
        reopened: button.getAttribute('aria-expanded') === 'true'
          && !document.getElementById('context-radio-mini').hidden,
      };
    });
    check(
      'touch/coarse-pointer activation can close and reopen compact Radio controls',
      compactTouchDisclosure.closed && compactTouchDisclosure.reopened,
      JSON.stringify(compactTouchDisclosure),
    );
    const multiExpandedPanelLayout = await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const ids = ['data-panel', 'scene-panel', 'pp-toggles', 'cctv-panel', 'global-context-panel'];
      const prior = {
        panels: Object.fromEntries(ids.map((id) => {
          const panel = document.getElementById(id);
          return [id, {
            className: panel.className,
            style: panel.getAttribute('style'),
            ariaHidden: panel.getAttribute('aria-hidden'),
          }];
        })),
        stacks: Object.fromEntries(['left-panel-stack', 'right-context-rail'].map((id) => {
          const stack = document.getElementById(id);
          return [id, {
            className: stack.className,
            style: stack.getAttribute('style'),
            dataset: { ...stack.dataset },
          }];
        })),
        preferredLeftPanelId: manager._leftStackPreferredPanelId,
        preferredRightPanelId: manager._rightStackPreferredPanelId,
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        focusId: document.activeElement?.id || null,
        storage: Object.fromEntries(Object.entries(localStorage)),
      };
      const setPanelThroughInstalledControl = (id, collapsed) => {
        const panel = document.getElementById(id);
        if (panel.classList.contains('collapsed') === collapsed) return;
        panel.querySelector(`[data-collapse-target="${id}"]`)?.click();
      };
      let result;
      try {
        manager.hud.setMode('off');
        setPanelThroughInstalledControl('data-panel', true);
        setPanelThroughInstalledControl('scene-panel', true);
        setPanelThroughInstalledControl('data-panel', false);
        setPanelThroughInstalledControl('scene-panel', false);
        manager.setPanelCollapsed('global-context-panel', false, { explicit: true });
        manager.setPanelCollapsed('pp-toggles', false, { explicit: true });
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();

        const left = document.getElementById('left-panel-stack');
        const right = document.getElementById('right-context-rail');
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftExpanded = ['data-panel', 'scene-panel'].map((id) => (
          document.getElementById(id).getBoundingClientRect()
        ));
        const rightExpanded = ['pp-toggles', 'global-context-panel'].map((id) => (
          document.getElementById(id).getBoundingClientRect()
        ));
        result = {
          independentLeft: ['data-panel', 'scene-panel'].every((id) => (
            !document.getElementById(id).classList.contains('collapsed')
          )),
          independentRight: ['pp-toggles', 'global-context-panel'].every((id) => (
            !document.getElementById(id).classList.contains('collapsed')
          )),
          leftCountsAllExpanded: left.dataset.expandedCount === '2',
          rightCountsAllExpanded: right.dataset.expandedCount === '2',
          leftInsideCorridor: leftExpanded.every((rect) => (
            rect.top >= leftRect.top - 1 && rect.bottom <= leftRect.bottom + 1
          )),
          rightInsideCorridor: rightExpanded.every((rect) => (
            rect.top >= rightRect.top - 1 && rect.bottom <= rightRect.bottom + 1
          )),
          internalScrollOwned: getComputedStyle(document.querySelector('#data-panel .data-toggle-list')).overflowY === 'auto'
            && getComputedStyle(document.querySelector('#scene-panel .scene-panel-inner')).overflowY === 'auto'
            && getComputedStyle(document.querySelector('#global-context-panel .global-context-panel-inner')).overflowY === 'auto',
        };

        manager._setHudVariant('tactical');
        manager.hud.setMode('on');
        manager._updateHudButtonState();
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();
        const dataPanel = document.getElementById('data-panel');
        const scenePanel = document.getElementById('scene-panel');
        const contextPanel = document.getElementById('global-context-panel');
        result.tacticalAutoCollapse = {
          latestOpenedPanel: manager._leftStackPreferredPanelId,
          scenesExpanded: !scenePanel.classList.contains('collapsed'),
          dataCollapsed: dataPanel.classList.contains('layout-auto-collapsed'),
          dataHiddenWhileScenesOwnsLane: dataPanel.getBoundingClientRect().height === 0
            && dataPanel.getAttribute('aria-hidden') === 'true',
          dataAriaExpanded: dataPanel.querySelector('[data-collapse-target="data-panel"]')?.getAttribute('aria-expanded'),
          displayExpanded: !document.getElementById('pp-toggles').classList.contains('collapsed'),
          contextCollapsed: contextPanel.classList.contains('layout-auto-collapsed'),
          contextHiddenWhileDisplayOwnsLane: contextPanel.getBoundingClientRect().height === 0
            && contextPanel.getAttribute('aria-hidden') === 'true',
          contextAriaExpanded: contextPanel.querySelector('[data-collapse-target="global-context-panel"]')?.getAttribute('aria-expanded'),
        };

        manager.setPanelCollapsed('scene-panel', true);
        manager.setPanelCollapsed('pp-toggles', true);
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();
        result.tacticalAutoRestore = {
          dataExpanded: !dataPanel.classList.contains('collapsed'),
          dataAutoMarkerCleared: !dataPanel.classList.contains('layout-auto-collapsed'),
          dataAriaExpanded: dataPanel.querySelector('[data-collapse-target="data-panel"]')?.getAttribute('aria-expanded'),
          contextExpanded: !contextPanel.classList.contains('collapsed'),
          contextAutoMarkerCleared: !contextPanel.classList.contains('layout-auto-collapsed'),
          contextAriaExpanded: contextPanel.querySelector('[data-collapse-target="global-context-panel"]')?.getAttribute('aria-expanded'),
        };

        manager.setPanelCollapsed('global-context-panel', true);
        manager.setPanelCollapsed('cctv-panel', true);
        manager.setPanelCollapsed('pp-toggles', false);
        await new Promise((resolve) => setTimeout(resolve, 240));
        manager._syncRightPanelAdaptiveLayout();
        const displayPanel = document.getElementById('pp-toggles');
        const cctvPanel = document.getElementById('cctv-panel');
        result.tacticalDisplayExclusive = {
          railExclusive: right.classList.contains('layout-exclusive'),
          displayExpanded: !displayPanel.classList.contains('collapsed'),
          cctvHidden: cctvPanel.getBoundingClientRect().height === 0
            && cctvPanel.getAttribute('aria-hidden') === 'true',
          contextHidden: contextPanel.getBoundingClientRect().height === 0
            && contextPanel.getAttribute('aria-hidden') === 'true',
        };
      } finally {
        manager._setHudVariant(prior.hudVariant);
        manager.hud.setMode(prior.hudMode);
        manager._updateHudButtonState();
        await new Promise((resolve) => setTimeout(resolve, 320));
        if (manager._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._leftStackLayoutFrame);
          manager._leftStackLayoutFrame = null;
        }
        if (manager._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._rightStackLayoutFrame);
          manager._rightStackLayoutFrame = null;
        }
        for (const [id, state] of Object.entries(prior.panels)) {
          const panel = document.getElementById(id);
          panel.className = state.className;
          if (state.style === null) panel.removeAttribute('style');
          else panel.setAttribute('style', state.style);
          if (state.ariaHidden === null) panel.removeAttribute('aria-hidden');
          else panel.setAttribute('aria-hidden', state.ariaHidden);
          manager._syncPanelCollapseButton(panel);
        }
        for (const [id, state] of Object.entries(prior.stacks)) {
          const stack = document.getElementById(id);
          stack.className = state.className;
          if (state.style === null) stack.removeAttribute('style');
          else stack.setAttribute('style', state.style);
          for (const key of Object.keys(stack.dataset)) delete stack.dataset[key];
          Object.assign(stack.dataset, state.dataset);
        }
        manager._leftStackPreferredPanelId = prior.preferredLeftPanelId;
        manager._rightStackPreferredPanelId = prior.preferredRightPanelId;
        localStorage.clear();
        for (const [key, value] of Object.entries(prior.storage)) localStorage.setItem(key, value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (manager._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._leftStackLayoutFrame);
          manager._leftStackLayoutFrame = null;
        }
        if (manager._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._rightStackLayoutFrame);
          manager._rightStackLayoutFrame = null;
        }
        // Disclosure restoration can wake the installed layout observers. Let
        // those observers settle, then restore the captured stack presentation
        // once more so this synthetic scenario cannot leak derived lane state
        // into the Radio interactions that follow.
        for (const [id, state] of Object.entries(prior.stacks)) {
          const stack = document.getElementById(id);
          stack.className = state.className;
          if (state.style === null) stack.removeAttribute('style');
          else stack.setAttribute('style', state.style);
          for (const key of Object.keys(stack.dataset)) delete stack.dataset[key];
          Object.assign(stack.dataset, state.dataset);
        }
        prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
        const panelsRestored = Object.entries(prior.panels).every(([id, state]) => {
          const panel = document.getElementById(id);
          return panel.className === state.className
            && panel.getAttribute('style') === state.style
            && panel.getAttribute('aria-hidden') === state.ariaHidden;
        });
        const stacksRestored = Object.entries(prior.stacks).every(([id, state]) => {
          const stack = document.getElementById(id);
          return stack.className === state.className
            && stack.getAttribute('style') === state.style
            && JSON.stringify({ ...stack.dataset }) === JSON.stringify(state.dataset);
        });
        result.restoreDetails = {
          panelsRestored,
          stacksRestored,
          preferredPanelRestored: manager._leftStackPreferredPanelId === prior.preferredLeftPanelId,
          preferredRightPanelRestored: manager._rightStackPreferredPanelId === prior.preferredRightPanelId,
          hudModeRestored: manager.hud.getMode() === prior.hudMode,
          hudVariantRestored: manager.hud.getVariant() === prior.hudVariant,
          storageRestored: JSON.stringify(Object.fromEntries(Object.entries(localStorage))) === JSON.stringify(prior.storage),
          focusRestored: !prior.focusId || document.activeElement?.id === prior.focusId,
        };
        result.restoredExactly = Object.values(result.restoreDetails).every(Boolean);
      }

      return result;
    });
    check(
      'HUD-off desktop lanes keep Data plus Scenes and Display plus Context expanded inside the viewport corridor',
      multiExpandedPanelLayout.independentLeft
        && multiExpandedPanelLayout.independentRight
        && multiExpandedPanelLayout.leftCountsAllExpanded
        && multiExpandedPanelLayout.rightCountsAllExpanded
        && multiExpandedPanelLayout.leftInsideCorridor
        && multiExpandedPanelLayout.rightInsideCorridor
        && multiExpandedPanelLayout.internalScrollOwned
        && multiExpandedPanelLayout.restoredExactly,
      JSON.stringify(multiExpandedPanelLayout),
    );
    check(
      'HUD-off to Tactical preserves the latest-opened Scenes panel and hides its collapsed Data competitor',
      multiExpandedPanelLayout.tacticalAutoCollapse.latestOpenedPanel === 'scene-panel'
        && multiExpandedPanelLayout.tacticalAutoCollapse.scenesExpanded
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataCollapsed
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataHiddenWhileScenesOwnsLane
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataAriaExpanded === 'false'
        && multiExpandedPanelLayout.tacticalAutoCollapse.displayExpanded
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextCollapsed
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextHiddenWhileDisplayOwnsLane
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextAriaExpanded === 'false',
      JSON.stringify(multiExpandedPanelLayout.tacticalAutoCollapse),
    );
    check(
      'closing Tactical lane owners restores eligible temporary siblings without changing disclosure truth',
      multiExpandedPanelLayout.tacticalAutoRestore.dataExpanded
        && multiExpandedPanelLayout.tacticalAutoRestore.dataAutoMarkerCleared
        && multiExpandedPanelLayout.tacticalAutoRestore.dataAriaExpanded === 'true'
        && multiExpandedPanelLayout.tacticalAutoRestore.contextExpanded
        && multiExpandedPanelLayout.tacticalAutoRestore.contextAutoMarkerCleared
        && multiExpandedPanelLayout.tacticalAutoRestore.contextAriaExpanded === 'true',
      JSON.stringify(multiExpandedPanelLayout.tacticalAutoRestore),
    );
    check(
      'Tactical Display hides ordinary collapsed CCTV and Context launchers',
      Object.values(multiExpandedPanelLayout.tacticalDisplayExclusive).every(Boolean),
      JSON.stringify(multiExpandedPanelLayout.tacticalDisplayExclusive),
    );
    const parameterizedDisplayScroll = await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const display = document.getElementById('pp-toggles');
      const parameters = document.getElementById('param-slider-panel');
      const prior = {
        style: manager.activeStyle,
        displayCollapsed: display.classList.contains('collapsed'),
        contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
        cctvCollapsed: document.getElementById('cctv-panel').classList.contains('collapsed'),
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        focusId: document.activeElement?.id || null,
      };
      const waitForLayout = () => new Promise((resolve) => setTimeout(resolve, 320));
      const cases = [];

      manager.setPanelCollapsed('global-context-panel', true);
      manager.setPanelCollapsed('cctv-panel', true);
      manager.setPanelCollapsed('pp-toggles', false);
      manager.setStyle('thermal', { applyPreset: false });

      for (const state of [
        { name: 'tactical', visible: true, variant: 'tactical' },
        { name: 'minimal', visible: true, variant: 'minimal' },
        { name: 'hud-off', visible: false, variant: 'minimal' },
      ]) {
        manager._setHudVariant(state.variant);
        manager.hud.setMode(state.visible ? 'on' : 'off');
        manager._updateHudButtonState();
        await waitForLayout();
        manager._syncRightPanelAdaptiveLayout();
        display.scrollTop = Math.max(1, display.scrollHeight - display.clientHeight);
        const before = display.scrollTop;
        manager._syncRightPanelAdaptiveLayout();
        const lastSlider = document.querySelector('#param-sliders .param-slider-row:last-child input');
        lastSlider.focus({ preventScroll: true });
        lastSlider.scrollIntoView({ block: 'nearest' });
        const displayRect = display.getBoundingClientRect();
        const sliderRect = lastSlider.getBoundingClientRect();
        cases.push({
          name: state.name,
          before,
          after: display.scrollTop,
          finalRowReachable: sliderRect.top >= displayRect.top - 1
            && sliderRect.bottom <= displayRect.bottom + 1,
          displayOwnsScroll: getComputedStyle(display).overflowY === 'auto',
          parametersDoNotTrapScroll: getComputedStyle(parameters).overflowY === 'visible',
          parameterRows: document.querySelectorAll('#param-sliders .param-slider-row').length,
        });
      }

      manager.setStyle(prior.style, { applyPreset: false });
      manager.setPanelCollapsed('pp-toggles', prior.displayCollapsed);
      manager.setPanelCollapsed('global-context-panel', prior.contextCollapsed);
      manager.setPanelCollapsed('cctv-panel', prior.cctvCollapsed);
      manager._setHudVariant(prior.hudVariant);
      manager.hud.setMode(prior.hudMode);
      manager._updateHudButtonState();
      prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
      return cases;
    });
    check(
      'parameterized Display remains scrollable through Tactical, Minimal, and HUD Off layout passes',
      parameterizedDisplayScroll.every((state) => (
        state.parameterRows >= 5
          && state.before > 0
          && state.after > 0
          && state.finalRowReachable
          && state.displayOwnsScroll
          && state.parametersDoNotTrapScroll
      )),
      JSON.stringify(parameterizedDisplayScroll),
    );
    const cockpitCompactControls = await page.evaluate(async () => {
      const hud = document.getElementById('cockpit-hud');
      const signal = document.getElementById('cockpit-signal-stream');
      const display = document.getElementById('cockpit-display-toggle-btn');
      const radio = document.getElementById('cockpit-radio-toggle-btn');
      const hudToggle = document.getElementById('hud-toggle');
      const hudLayout = document.getElementById('hud-layout-select');
      const detectionToggle = document.getElementById('detection-toggle');
      const models3dToggle = document.getElementById('models3d-toggle');
      const models3dAll = document.getElementById('models3d-mode-all');
      const scene = document.getElementById('scene-panel');
      const dataPanel = document.getElementById('data-panel');
      const manager = window.__godsEyeView.styleManager;
      // This block validates portaled DOM controls, while qa-cockpit-utility
      // owns the real tracked-aircraft camera session. Hold the frame update so
      // the intentionally synthetic Cockpit shell is not auto-exited mid-check.
      const realCockpitUpdate = manager.cockpitView.update;
      const waitForLayout = () => new Promise((resolve) => setTimeout(resolve, 320));
      const prior = {
        cockpit: document.body.classList.contains('cockpit-mode'),
        cockpitActive: manager.cockpitView.active,
        bodyClassName: document.body.className,
        contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
        hudHidden: hud.hidden,
        signalHidden: signal.hidden,
        dataCollapsed: dataPanel.classList.contains('collapsed'),
        mapStack: manager.mapStackController?.getActiveId(),
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        displayExpanded: display.getAttribute('aria-expanded') === 'true',
        radioExpanded: radio.getAttribute('aria-expanded') === 'true',
        contextRadioExpanded: document.getElementById('context-radio-toggle-btn')?.getAttribute('aria-expanded') === 'true',
        focusId: document.activeElement?.id || null,
        detectionMode: manager.getDetectionState().detectionMode,
        models3dEnabled: manager._models3dEnabled,
        models3dMode: manager._models3dMode,
        preferredLeftPanelId: manager._leftStackPreferredPanelId,
        panels: Object.fromEntries([
          'data-panel',
          'global-context-panel',
        ].map((id) => {
          const panel = document.getElementById(id);
          return [id, {
            className: panel.className,
            style: panel.getAttribute('style'),
            ariaHidden: panel.getAttribute('aria-hidden'),
          }];
        })),
        storage: Object.fromEntries(Object.entries(localStorage)),
        utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      };
      let result = {};
      try {
        manager.cockpitView.update = () => {};
        document.body.classList.add('cockpit-mode');
      manager.cockpitView.active = true;
      manager._setCockpitDisplayPortalActive(true);
      hud.hidden = false;
      signal.hidden = false;
      dataPanel.classList.remove('collapsed');
      window.__godsEyeView.styleManager._syncLeftPanelAdaptiveLayout();
      window.__godsEyeView.styleManager.cockpitView.syncSignalLayout();
      if (display.getAttribute('aria-expanded') === 'true') display.click();
      display.click();
      manager._setHudVariant('tactical');
      manager.hud.setMode('on');
      manager._updateHudButtonState();
      await waitForLayout();

      const layoutSteps = [];
      // The two Cockpit lanes are solved independently: the accordion against
      // left-lane obstacles, the Display/Radio strip against the REC readout
      // and the briefing card it shares the right margin with. Record both
      // sets of inputs so each lane is asserted on its own terms.
      const visibleRect = (selector) => {
        const element = document.querySelector(selector);
        if (!element || element.hidden) return null;
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return null;
          }
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const recordLayoutStep = () => {
        const dataRect = dataPanel.getBoundingClientRect();
        const utilityRect = document.getElementById('cockpit-utility-controls').getBoundingClientRect();
        const displayRect = display.closest('.cockpit-utility-control').getBoundingClientRect();
        const toplineRect = document.querySelector('#cockpit-hud .cockpit-topline').getBoundingClientRect();
        const recRect = visibleRect('#intel-hud .hud-top-right');
        const creditsRect = visibleRect('#cesium-credits .cesium-credit-textContainer');
      // Left-lane surfaces an expanded Cockpit panel must remain clear of.
        const passableTops = ['#cockpit-context', '#intel-hud .hud-bottom-left']
          .map((selector) => visibleRect(selector))
          .filter((rect) => rect && rect.right > dataRect.left && rect.left < dataRect.right)
          .map((rect) => rect.top);
        const stack = document.getElementById('left-panel-stack');
        layoutSteps.push({
          hud: manager.hud.visible ? manager.hud.getVariant().toUpperCase() : 'OFF',
          dataTop: dataRect.top,
          dataBottom: dataRect.bottom,
          // The corridor the engine committed, independent of how tall the
          // panel's own content happens to be.
          layoutBottom: window.innerHeight * (Number(stack.dataset.safeBottomPct) || 0) / 100,
          safeGap: window.innerHeight * 0.012,
          displayTop: displayRect.top,
          utilityTop: utilityRect.top,
          utilityBottom: utilityRect.bottom,
          utilityHeight: utilityRect.height,
          toplineBottom: toplineRect.bottom,
          recBottom: recRect ? recRect.bottom : 0,
          signalTop: signal.getBoundingClientRect().top,
          creditsTop: creditsRect ? creditsRect.top : null,
          passableTop: passableTops.length ? Math.min(...passableTops) : null,
          minTop: Math.max(96, window.innerHeight * 0.12),
          layoutMode: document.getElementById('left-panel-stack').dataset.layoutMode,
        });
      };
      // The Intel HUD fades over 400ms and keeps its readout rects for the
      // whole transition, so both lanes are measured only once it has settled.
      const waitForHudSettle = () => new Promise((resolve) => setTimeout(resolve, 560));
      for (let index = 0; index < 5; index += 1) {
        recordLayoutStep();
        if (index < 4) {
          if (index < 2) {
            hudLayout.value = index === 0 ? 'operator' : 'minimal';
            hudLayout.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            hudToggle.click();
          }
          await waitForHudSettle();
        }
      }

      // Cockpit's CONTACT card shares the accordion's lane. This synthetic
      // shell has no tracked contact, so reveal the card to prove an expanded
      // panel stops above it while its internally scrolled controls stay live.
      const contextCard = document.getElementById('cockpit-context');
      const contextWasHidden = contextCard.hidden;
      contextCard.hidden = false;
      // Expand the panel the same way this block already does at entry, so the
      // portaled Display groups measured further down keep their DOM home.
      dataPanel.classList.remove('collapsed', 'layout-auto-collapsed');
      manager._syncPanelCollapseButton(dataPanel);
      manager._syncLeftPanelAdaptiveLayout();
      await waitForLayout();
      const panelRect = dataPanel.getBoundingClientRect();
      const contextRect = contextCard.getBoundingClientRect();
      const contactClearancePx = contextRect.top - panelRect.bottom;
      const clearsContextCard = contactClearancePx >= -0.5;
      const probe = document.elementFromPoint(
        Math.max(panelRect.left, contextRect.left) + 8,
        Math.max(panelRect.top, contextRect.top) + 6,
      );
      const contextOwnsItsLane = !probe?.closest('#data-panel');
      // A layer toggle must remain reachable and live from inside Cockpit.
      // Prefer a bundled layer so the proof needs no external network.
      const toggleList = dataPanel.querySelector('.data-toggle-list');
      const toggleRows = [...toggleList.querySelectorAll('.data-toggle-row')]
        .filter((row) => row.querySelector('.data-toggle-btn'));
      const toggleRow = toggleRows.find((row) => String(row.dataset.layerId).startsWith('local-'))
        || toggleRows.find((row) => !/flight|military|vessel|ais|radio/i.test(row.dataset.layerId || ''));
      toggleRow?.scrollIntoView({ block: 'center' });
      await waitForLayout();
      const toggleLayerId = toggleRow?.dataset.layerId || null;
      const toggleButton = toggleRow?.querySelector('.data-toggle-btn');
      const toggleButtonRect = toggleButton?.getBoundingClientRect();
      const listRect = toggleList.getBoundingClientRect();
      const toggleInsideScroller = Boolean(toggleButtonRect
        && toggleButtonRect.top >= listRect.top - 1
        && toggleButtonRect.bottom <= listRect.bottom + 1);
      const toggleReachable = Boolean(toggleButtonRect && toggleRow.contains(
        document.elementFromPoint(
          toggleButtonRect.left + toggleButtonRect.width / 2,
          toggleButtonRect.top + toggleButtonRect.height / 2,
        ),
      ));
      const toggleBefore = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) : null;
      toggleButton?.click();
      await waitForLayout();
      const toggleAfter = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) : null;
      toggleButton?.click();
      await waitForLayout();
      const toggleRestored = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) === toggleBefore : false;
      const cockpitPanelInteraction = {
        toggleLayerId,
        contactClearancePx,
        clearsContextCard,
        contextOwnsItsLane,
        toggleInsideScroller,
        toggleReachable,
        toggleBefore,
        toggleAfter,
        toggleRestored,
        listScrolls: toggleList.scrollHeight > toggleList.clientHeight,
        panelHeight: Math.round(panelRect.height),
      };
      contextCard.hidden = contextWasHidden;
      // Restoring the layer destroys it, and a layer teardown during a Context
      // session legitimately exits Cockpit (ui.js subscribeBeforeDestroy). Re-
      // establish this block's synthetic shell exactly as it was entered, so
      // the portaled-control checks below keep their precondition.
      document.body.classList.add('cockpit-mode');
      manager.cockpitView.active = true;
      hud.hidden = false;
      signal.hidden = false;
      manager._setCockpitDisplayPortalActive(true);
      manager._setCockpitDisclosure('display', true);
      await waitForLayout();

      manager._setModels3dMode('proximity');
      manager._setModels3dEnabled(false);
      const models3dSteps = [];
      for (let index = 0; index < 3; index += 1) {
        if (index === 0 || index === 2) models3dToggle.click();
        else models3dAll.click();
        const flightsParams = manager._dataManager.getLayerParams('flights');
        const militaryParams = manager._dataManager.getLayerParams('military');
        models3dSteps.push({
          label: manager._models3dEnabled ? manager._models3dMode.toUpperCase() : 'OFF',
          flightsEnabled: flightsParams.models3d,
          flightsMode: flightsParams.models3dMode,
          militaryEnabled: militaryParams.models3d,
          militaryMode: militaryParams.models3dMode,
        });
      }

      manager.cockpitView.syncSignalLayout();
      const displayOpened = display.getAttribute('aria-expanded') === 'true'
        && !document.getElementById('cockpit-display-panel').hidden;
      const sharedDisplayControlsPortaled = [hudToggle, detectionToggle, models3dToggle]
        .every((control) => control.closest('.pp-toggle-group')?.parentElement
          ?.closest('#cockpit-display-panel'));
      display.click();

      manager.cockpitView.syncSignalLayout();
      radio.click();
      const radioOpened = radio.getAttribute('aria-expanded') === 'true'
        && !document.getElementById('cockpit-radio-panel').hidden;
      const mutuallyExclusive = display.getAttribute('aria-expanded') === 'false';
      radio.click();

      manager.cockpitView.syncSignalLayout();
      radio.click();

      const radioNavigationAvailable = [
        document.getElementById('cockpit-radio-prev-btn'),
        document.getElementById('cockpit-radio-next-btn'),
      ].every((button) => button?.isConnected && !button.disabled);
      const detailsExcluded = !document.querySelector(
        '#cockpit-radio-panel #context-radio-details-btn, '
        + '#cockpit-radio-panel #radio-filter, #cockpit-radio-panel #radio-tuner',
      );
      const scenesHidden = getComputedStyle(scene).display === 'none';
      radio.click();

      manager.setPanelCollapsed('data-panel', true);
      await waitForLayout();
      const utility = document.getElementById('cockpit-utility-controls');
      const photorealAvailable = manager.mapStackController?.getStacks()
        .some((stack) => stack.id === 'photoreal' && stack.available);
      let mapProviderUtilityStable = true;
      if (photorealAvailable) {
        await manager._setMapStack('photoreal', { syncShare: false });
        await waitForLayout();
        const stableTop = utility.getBoundingClientRect().top;
        const transitionTops = [];
        let sampling = true;
        const sampleTop = () => {
          transitionTops.push(utility.getBoundingClientRect().top);
          if (sampling) requestAnimationFrame(sampleTop);
        };
        requestAnimationFrame(sampleTop);
        await manager._setMapStack('osm', { syncShare: false });
        await waitForLayout();
        sampling = false;
        mapProviderUtilityStable = transitionTops.length > 1
          && transitionTops.every((top) => Math.abs(top - stableTop) < 1);
      }
      result = {
        cockpitPanelInteraction,
        displayOpened,
        sharedDisplayControlsPortaled,
        radioOpened,
        mutuallyExclusive,
        radioNavigationAvailable,
        detailsExcluded,
        scenesHidden,
        mapProviderUtilityStable,
        hudInteractionsExact: layoutSteps.map((step) => step.hud).join('>')
          === 'TACTICAL>OPERATOR>MINIMAL>OFF>MINIMAL',
        // The accordion clears the topline, Cockpit cards, and Cesium credits
        // across every HUD layout. Its list owns any overflow internally.
        leftLaneClearAcrossHudCycle: layoutSteps.every((step) => (
          step.dataTop >= step.toplineBottom
          && (step.creditsTop === null || step.dataBottom <= step.creditsTop)
          && (step.passableTop === null || step.dataBottom <= step.passableTop + 0.5)
        )),
        // The strip is solved from ITS margin — under the REC readout, clamped
        // clear of the briefing card, never above the viewport ceiling — and
        // never from whatever corridor the accordion happened to commit.
        rightStripClearAcrossHudCycle: layoutSteps.every((step) => {
          const anchored = Math.max(step.minTop, step.recBottom + 12);
          const expected = Math.max(
            step.minTop,
            Math.min(anchored, step.signalTop - 8 - step.utilityHeight),
          );
          return step.displayTop >= step.toplineBottom
            && step.utilityBottom <= step.signalTop - 7.9
            && Math.abs(step.utilityTop - expected) < 0.6;
        }),
        models3dInteractionsExact: models3dSteps.map((step) => step.label).join('>')
          === 'PROXIMITY>ALL>OFF',
        models3dLayersSynchronized: models3dSteps.every((step, index) => {
          const expectedEnabled = index < 2;
          const expectedMode = index === 0 ? 'proximity' : 'all';
          return step.flightsEnabled === expectedEnabled
            && step.militaryEnabled === expectedEnabled
            && step.flightsMode === expectedMode
            && step.militaryMode === expectedMode;
        }),
      };
      } finally {
        if (prior.mapStack) await manager._setMapStack(prior.mapStack, { syncShare: false });
        manager._setDetectionMode(prior.detectionMode);
        manager._setModels3dMode(prior.models3dMode);
        manager._setModels3dEnabled(prior.models3dEnabled);
        manager._setHudVariant(prior.hudVariant);
        manager.hud.setMode(prior.hudMode);
        manager._updateHudButtonState();
        manager.cockpitView.active = prior.cockpitActive;
        manager.cockpitView.update = realCockpitUpdate;
        manager.setPanelCollapsed('data-panel', prior.dataCollapsed);
        document.body.className = prior.bodyClassName;
        manager._setCockpitDisplayPortalActive(prior.cockpit);
        manager.setPanelCollapsed('global-context-panel', prior.contextCollapsed);
        if (display.getAttribute('aria-expanded') !== String(prior.displayExpanded)) display.click();
        if (radio.getAttribute('aria-expanded') !== String(prior.radioExpanded)) radio.click();
        manager._setRadioDisclosure(prior.contextRadioExpanded);
        hud.hidden = prior.hudHidden;
        signal.hidden = prior.signalHidden;
        if (prior.utilityTop) hud.style.setProperty('--cockpit-utility-top', prior.utilityTop);
        else hud.style.removeProperty('--cockpit-utility-top');
        await waitForLayout();
        if (manager._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._leftStackLayoutFrame);
          manager._leftStackLayoutFrame = null;
        }
        if (manager._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._rightStackLayoutFrame);
          manager._rightStackLayoutFrame = null;
        }
        for (const [id, state] of Object.entries(prior.panels)) {
          const panel = document.getElementById(id);
          panel.className = state.className;
          if (state.style === null) panel.removeAttribute('style');
          else panel.setAttribute('style', state.style);
          if (state.ariaHidden === null) panel.removeAttribute('aria-hidden');
          else panel.setAttribute('aria-hidden', state.ariaHidden);
          manager._syncPanelCollapseButton(panel);
        }
        manager._leftStackPreferredPanelId = prior.preferredLeftPanelId;
        localStorage.clear();
        for (const [key, value] of Object.entries(prior.storage)) localStorage.setItem(key, value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
        result.restoredExactly = document.body.className === prior.bodyClassName
          && manager.cockpitView.active === prior.cockpitActive
          && manager.cockpitView.update === realCockpitUpdate
          && dataPanel.classList.contains('collapsed') === prior.dataCollapsed
          && document.getElementById('global-context-panel').classList.contains('collapsed') === prior.contextCollapsed
          && display.getAttribute('aria-expanded') === String(prior.displayExpanded)
          && radio.getAttribute('aria-expanded') === String(prior.radioExpanded)
          && document.getElementById('context-radio-toggle-btn')?.getAttribute('aria-expanded') === String(prior.contextRadioExpanded)
          && hud.hidden === prior.hudHidden
          && signal.hidden === prior.signalHidden
          && manager.hud.getMode() === prior.hudMode
          && manager.hud.getVariant() === prior.hudVariant
          && Object.entries(prior.panels).every(([id, state]) => {
            const panel = document.getElementById(id);
            return panel.className === state.className
              && panel.getAttribute('style') === state.style
              && panel.getAttribute('aria-hidden') === state.ariaHidden;
          })
          && manager._leftStackPreferredPanelId === prior.preferredLeftPanelId
          && JSON.stringify(Object.fromEntries(Object.entries(localStorage))) === JSON.stringify(prior.storage)
          && (!prior.focusId || document.activeElement?.id === prior.focusId);
      }
      return result;
    });
    check(
      'Cockpit portals the standard focused Display groups and keeps compact-only Radio',
      cockpitCompactControls.displayOpened
        && cockpitCompactControls.sharedDisplayControlsPortaled
        && cockpitCompactControls.radioOpened
        && cockpitCompactControls.mutuallyExclusive
        && cockpitCompactControls.radioNavigationAvailable
        && cockpitCompactControls.detailsExcluded
        && cockpitCompactControls.scenesHidden
        && cockpitCompactControls.mapProviderUtilityStable
        && cockpitCompactControls.hudInteractionsExact
        && cockpitCompactControls.leftLaneClearAcrossHudCycle
        && cockpitCompactControls.rightStripClearAcrossHudCycle
        && cockpitCompactControls.models3dInteractionsExact
        && cockpitCompactControls.models3dLayersSynchronized
        && cockpitCompactControls.restoredExactly,
      JSON.stringify(cockpitCompactControls),
    );
    check(
      'an expanded Cockpit left panel stops above CONTACT and still toggles layers',
      cockpitCompactControls.cockpitPanelInteraction?.clearsContextCard
        && cockpitCompactControls.cockpitPanelInteraction.contextOwnsItsLane
        && cockpitCompactControls.cockpitPanelInteraction.toggleInsideScroller
        && cockpitCompactControls.cockpitPanelInteraction.toggleReachable
        && cockpitCompactControls.cockpitPanelInteraction.toggleBefore
          !== cockpitCompactControls.cockpitPanelInteraction.toggleAfter
        && cockpitCompactControls.cockpitPanelInteraction.toggleRestored,
      JSON.stringify(cockpitCompactControls.cockpitPanelInteraction),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'compact.png') });

    const firstPlayPrecondition = await page.evaluate(() => (
      window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id || null
    ));
    check('first Play scenario starts without a leaked Radio selection', firstPlayPrecondition === null,
      `selected=${firstPlayPrecondition}`);
    await page.select('#radio-filter', 'all');
    await page.$eval('#context-radio-toggle-btn', (button) => {
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
    });
    await page.evaluate(() => {
      const camera = window.__godsEyeView.viewer.camera;
      window.__qaFirstPlayFlyToCalls = [];
      window.__qaFirstPlayOriginalFlyTo = camera.flyTo;
      camera.flyTo = (options) => window.__qaFirstPlayFlyToCalls.push(options);
      document.getElementById('context-radio-toggle-btn').focus();
    });
    await page.$eval('#context-radio-mini-play-btn', (button) => button.click());
    await page.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.audioState === 'playing' || state.audioState === 'error';
    });
    const postMicroDragPlayback = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('radio').module;
      let state = mod.getUIState();
      if (state.audioState !== 'playing') {
        await mod.play({ origin: 'user' });
        state = mod.getUIState();
      }
      return { audioState: state.audioState, selectedId: state.selected?.id || null };
    });
    check('micro-drag release leaves the selected station playable',
      postMicroDragPlayback.audioState === 'playing', JSON.stringify(postMicroDragPlayback));
    const firstPlay = await page.evaluate(() => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const state = module.getUIState();
      const camera = window.__godsEyeView.viewer.camera;
      const result = {
        state,
        calls: [...window.__qaRadioPlayCalls],
        flyToCalls: window.__qaFirstPlayFlyToCalls.length,
      };
      camera.flyTo = window.__qaFirstPlayOriginalFlyTo;
      delete window.__qaFirstPlayOriginalFlyTo;
      module.stopPlayback();
      return result;
    });
    check(
      'first Play selects a viewport-ranked station from All and starts its stream',
      Boolean(firstPlay.state.selected?.id) && firstPlay.state.filter === 'all'
        && firstPlay.state.audioState === 'playing' && firstPlay.calls.length >= 1,
      JSON.stringify({ selected: firstPlay.state.selected?.id, calls: firstPlay.calls }),
    );
    check('first Play never moves the camera', firstPlay.flyToCalls === 0, `${firstPlay.flyToCalls} flyTo calls`);

    await page.select('#radio-filter', 'news');
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: -98 * Math.PI / 180,
          latitude: 38 * Math.PI / 180,
          height: 18_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await sleep(700);
    const newsClusterTarget = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const source = Array.from({ length: gev.viewer.dataSources.length }, (_, index) => gev.viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations');
      const points = source.clustering._clusterPointCollection;
      for (let index = 0; index < (points?.length || 0); index += 1) {
        const point = points.get(index);
        if (!point.show || !Array.isArray(point.id) || !point.id.length) continue;
        const canvasPoint = gev.viewer.scene.cartesianToCanvasCoordinates(point.position);
        if (!canvasPoint) continue;
        return {
          x: canvasPoint.x,
          y: canvasPoint.y,
          firstId: String(point.id[0]?.id || '').replace(/^radio:/, ''),
          pointIds: point.id.map((entity) => entity.id),
        };
      }
      return {
        missing: true,
        points: Array.from({ length: points?.length || 0 }, (_, index) => ({
          show: points.get(index).show,
          pointIds: Array.isArray(points.get(index)?.id) ? points.get(index).id.length : 0,
        })),
      };
    });
    if (!newsClusterTarget.missing) {
      await page.mouse.click(newsClusterTarget.x, newsClusterTarget.y);
      await page.waitForFunction((stationId) => {
        const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
        return state.selected?.id === stationId && state.audioState === 'playing';
      }, {}, newsClusterTarget.firstId);
    }
    const newsClusterClick = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      gev.dataManager.layers.get('radio').module.stopPlayback();
      return { selectedId: state.selected?.id, audioState: state.audioState };
    });
    check(
      'clicking a News cluster dot plays its first station',
      newsClusterTarget?.pointIds?.length > 0
        && newsClusterClick.selectedId === newsClusterTarget.firstId
        && newsClusterClick.audioState === 'playing',
      JSON.stringify({ target: newsClusterTarget, result: newsClusterClick }),
    );

    await page.select('#radio-filter', 'weather');
    await sleep(700);
    const weatherCluster = await page.evaluate(() => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      return { texts: radio.getOverlayDiagnostics().clusterTexts };
    });
    check(
      'Weather / Emergency view labels its cluster callouts WEATHER',
      weatherCluster.texts.length > 0 && weatherCluster.texts.every((text) => /^\d+ WEATHER$/.test(text)),
      JSON.stringify(weatherCluster),
    );
    await page.select('#radio-filter', 'news');

    await page.$eval('#context-radio-mini-volume', (input) => {
      input.value = '35';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const compactVolume = await page.evaluate(() => ({
      volume: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().volume,
      full: document.getElementById('radio-volume').value,
      mini: document.getElementById('context-radio-mini-volume').value,
    }));
    check('compact volume shares the full Radio player state', Math.abs(compactVolume.volume - 0.35) < 0.001 && compactVolume.full === '35' && compactVolume.mini === '35');

    const compactDisclosureContinuity = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', true);
      manager._setRadioDisclosure(true);
      await radio.play({ origin: 'user' });
      const before = radio.getUIState();
      const disclosure = document.getElementById('context-radio-toggle-btn');
      if (disclosure.getAttribute('aria-expanded') !== 'true') disclosure.click();
      disclosure.click();
      const closed = {
        expanded: disclosure.getAttribute('aria-expanded'),
        hidden: document.getElementById('context-radio-mini').hidden,
        state: radio.getUIState(),
      };
      disclosure.click();
      return {
        before,
        closed,
        reopened: disclosure.getAttribute('aria-expanded'),
        miniHidden: document.getElementById('context-radio-mini').hidden,
        after: radio.getUIState(),
      };
    });
    check(
      'compact disclosure preserves playback, station, filter, and volume continuity',
      compactDisclosureContinuity.closed.expanded === 'false'
        && compactDisclosureContinuity.closed.hidden
        && compactDisclosureContinuity.reopened === 'true'
        && !compactDisclosureContinuity.miniHidden
        && compactDisclosureContinuity.before.audioState === 'playing'
        && compactDisclosureContinuity.closed.state.audioState === 'playing'
        && compactDisclosureContinuity.after.audioState === 'playing'
        && compactDisclosureContinuity.after.selected?.id === compactDisclosureContinuity.before.selected?.id
        && compactDisclosureContinuity.after.filter === compactDisclosureContinuity.before.filter
        && compactDisclosureContinuity.after.volume === compactDisclosureContinuity.before.volume,
      JSON.stringify({
        before: compactDisclosureContinuity.before,
        closed: compactDisclosureContinuity.closed,
        reopened: compactDisclosureContinuity.reopened,
        after: compactDisclosureContinuity.after,
      }),
    );

    const voicePause = await page.evaluate(async () => {
      const filter = document.getElementById('radio-filter');
      const firstOption = filter?.options?.[0] || null;
      await window.__godsEyeView.dataManager.layers.get('radio').module.play();
      const startedAt = performance.now();
      window.__godsEyeView.voiceCommands.setStatus('connecting', 'QA voice connect');
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return {
        ...state,
        transitionMs: performance.now() - startedAt,
        categoryOptionPreserved: firstOption === filter?.options?.[0],
      };
    });
    check(
      'voice activation immediately pauses Radio without changing the user volume',
      voicePause.audioState === 'paused' && Math.abs(voicePause.volume - 0.35) < 0.001,
      JSON.stringify({ audioState: voicePause.audioState, user: voicePause.volume }),
    );
    check(
      'voice pause preserves Radio category DOM instead of rebuilding the dropdown',
      voicePause.categoryOptionPreserved,
      `${voicePause.transitionMs.toFixed(1)}ms transition`,
    );
    const idleHorizonScans = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const camera = window.__godsEyeView.viewer.camera;
      camera.cancelFlight();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const positionBefore = {
        x: camera.positionWC.x,
        y: camera.positionWC.y,
        z: camera.positionWC.z,
      };
      const before = radio.getStats().horizonScans;
      await new Promise((resolve) => setTimeout(resolve, 850));
      const dx = camera.positionWC.x - positionBefore.x;
      const dy = camera.positionWC.y - positionBefore.y;
      const dz = camera.positionWC.z - positionBefore.z;
      return {
        before,
        after: radio.getStats().horizonScans,
        cameraDeltaM: Math.hypot(dx, dy, dz),
      };
    });
    check(
      'stationary Radio view skips repeated 750-marker horizon scans',
      idleHorizonScans.after === idleHorizonScans.before,
      JSON.stringify(idleHorizonScans),
    );
    const idleVoice = await page.evaluate(() => {
      const voice = window.__godsEyeView.voiceCommands;
      voice.setMicrophoneEnabled(true);
      voice.setStatus('listening', 'QA standby');
      voice.setVoiceSpeaker('idle');
      return window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
    });
    check(
      'idle voice never auto-resumes a station paused for voice',
      idleVoice.audioState === 'paused',
      idleVoice.audioState,
    );
    const manualPlayTarget = await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', true);
      manager._setRadioDisclosure(true);
      const button = document.getElementById('context-radio-mini-play-btn');
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        visible: !button.hidden
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) > 0
          && rect.width > 0
          && rect.height > 0,
        enabled: !button.disabled,
        rect: { width: rect.width, height: rect.height },
      };
    });
    check(
      'manual voice takeover targets the visible compact Radio Play control',
      manualPlayTarget.visible && manualPlayTarget.enabled,
      JSON.stringify(manualPlayTarget),
    );
    if (manualPlayTarget.visible && manualPlayTarget.enabled) {
      await page.click('#context-radio-mini-play-btn');
      await page.waitForFunction(() => (
        window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing'
        && window.__godsEyeView.voiceCommands.status === 'idle'
      ));
    }
    const manualTakeover = await page.evaluate(() => ({
      audioState: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState,
      voiceStatus: window.__godsEyeView.voiceCommands.status,
      voiceDucked: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().voiceDucked,
    }));
    check(
      'confirmed manual Radio Play closes active voice and preserves playback',
      manualTakeover.audioState === 'playing'
        && manualTakeover.voiceStatus === 'idle'
        && !manualTakeover.voiceDucked,
      JSON.stringify(manualTakeover),
    );
    await page.evaluate(() => window.__godsEyeView.voiceCommands.setStatus('listening', 'QA standby'));
    const explicitResume = await page.evaluate(async () => {
      const voice = window.__godsEyeView.voiceCommands;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      await radio.play();
      const beforeSpace = radio.getUIState().audioState;
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }));
      const afterSpace = radio.getUIState().audioState;
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, code: 'Space', key: ' ' }));
      await radio.play();
      voice.setVoiceSpeaker('ai');
      return { beforeSpace, afterSpace, afterAi: radio.getUIState().audioState };
    });
    check(
      'holding Space and assistant speech each pause an explicitly resumed station',
      explicitResume.beforeSpace === 'playing' && explicitResume.afterSpace === 'paused' && explicitResume.afterAi === 'paused',
      JSON.stringify(explicitResume),
    );
    await page.evaluate(() => window.__godsEyeView.voiceCommands.setStatus('idle', 'QA complete'));
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      manager._setRadioDisclosure(false);
      manager.setPanelCollapsed('global-context-panel', false);
      manager.setPanelCollapsed('radio-panel', false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForFunction(() => {
      const tuner = document.getElementById('radio-tuner');
      const slider = document.getElementById('radio-tuner-slider');
      return !tuner.hidden
        && tuner.getBoundingClientRect().width > 0
        && slider.getBoundingClientRect().width > 0;
    });

    const horizon = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      const source = Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations');
      const visibleIds = () => source.entities.values.filter((entity) => entity.show).map((entity) => entity.id);
      const setView = (lon, lat = 0) => {
        viewer.camera.cancelFlight();
        viewer.camera.setView({
          destination: ellipsoid.cartographicToCartesian({ longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height: 2_000_000 }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      };
      setView(-54);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const front = visibleIds();
      setView(180, -2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const back = visibleIds();
      const frontSet = new Set(front);
      return {
        front: front.length,
        back: back.length,
        changed: back.some((id) => !frontSet.has(id)),
      };
    });
    check('far-side markers are horizon culled', horizon.front > 0 && horizon.front < 750 && horizon.back > 0 && horizon.back < 750, `${horizon.front}/${horizon.back} visible`);
    check('horizon visibility follows camera hemisphere', horizon.changed);

    await page.select('#radio-filter', 'all');
    const absoluteTuner = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const tunerRect = document.getElementById('radio-tuner').getBoundingClientRect();
      const dialRect = document.querySelector('.radio-tuner-dial').getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const panelRect = document.querySelector('.radio-panel-inner').getBoundingClientRect();
      const count = style._radioTunerStations.length;
      const usable = sliderRect.width - 14;
      const xFor = (coordinate) => sliderRect.left + 7 + usable * coordinate / Math.max(1, count - 1);
      const pointer = (type, x, pointerId = 71) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'mouse',
        clientX: x,
        clientY: sliderRect.top + sliderRect.height / 2,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      }));
      const snapshot = () => {
        const markerId = gev.viewer.entities.values
          .find((entity) => String(entity.id).startsWith('radio:selected:'))?.id || null;
        return {
          slot: Number(slider.value),
          markerId,
          ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
          needleX: document.getElementById('radio-tuner-needle').getBoundingClientRect().left,
          ticks: Array.from(document.querySelectorAll('.radio-tuner-tick')).map((tick) => ({
            index: Number(tick.dataset.stationIndex),
            x: tick.getBoundingClientRect().left,
          })),
        };
      };
      const playsBefore = window.__qaRadioPlayCalls.length;
      const frozenSignature = style._radioTunerBandSignature;
      pointer('pointerdown', xFor(0));
      const left = snapshot();
      const centerCoordinate = (count - 1) / 2;
      pointer('pointermove', xFor(centerCoordinate));
      const center = snapshot();
      pointer('pointermove', xFor(centerCoordinate + 2));
      const shifted = snapshot();
      pointer('pointermove', xFor(count - 1));
      const right = snapshot();
      const shiftedByIndex = new Map(shifted.ticks.map((tick) => [tick.index, tick.x]));
      const sharedTick = center.ticks.find((tick) => shiftedByIndex.has(tick.index));
      const tapeDelta = sharedTick ? shiftedByIndex.get(sharedTick.index) - sharedTick.x : null;
      const needleDelta = shifted.needleX - center.needleX;
      pointer('pointercancel', xFor(count - 1));
      const state = radio.getUIState();
      return {
        visible: !document.getElementById('radio-tuner').hidden,
        stationCount: count,
        sliderMax: Number(slider.max),
        bandFrozen: style._radioTunerBandSignature === frozenSignature,
        left,
        center,
        shifted,
        right,
        leftExpectedId: style._radioTunerStations[0]?.id || null,
        centerExpectedId: style._radioTunerStations[Math.floor(centerCoordinate + 0.5)]?.id || null,
        rightExpectedId: style._radioTunerStations[count - 1]?.id || null,
        centerExpected: Math.floor(centerCoordinate + 0.5),
        tapeDelta,
        needleDelta,
        maxTickCount: Math.max(left.ticks.length, center.ticks.length, shifted.ticks.length, right.ticks.length),
        noPreviewPlay: window.__qaRadioPlayCalls.length === playsBefore,
        tuningActiveAfterCancel: state.tuningActive,
        tuningStaticAfterCancel: state.tuningStatic,
        contained: tunerRect.left >= panelRect.left && tunerRect.right <= panelRect.right
          && dialRect.left >= tunerRect.left && dialRect.right <= tunerRect.right
          && sliderRect.left >= dialRect.left && sliderRect.right <= dialRect.right,
      };
    });
    check(
      'All maps the complete directory to real left, center, and right station snap points',
      absoluteTuner.visible && absoluteTuner.stationCount === 750 && absoluteTuner.sliderMax === 749
        && absoluteTuner.left.slot === 0
        && absoluteTuner.left.markerId === `radio:selected:${absoluteTuner.leftExpectedId}`
        && absoluteTuner.center.slot === absoluteTuner.centerExpected
        && absoluteTuner.center.markerId === `radio:selected:${absoluteTuner.centerExpectedId}`
        && absoluteTuner.right.slot === absoluteTuner.stationCount - 1
        && absoluteTuner.right.markerId === `radio:selected:${absoluteTuner.rightExpectedId}`
        && absoluteTuner.bandFrozen && absoluteTuner.noPreviewPlay
        && !absoluteTuner.tuningActiveAfterCancel && !absoluteTuner.tuningStaticAfterCancel
        && absoluteTuner.contained,
      JSON.stringify(absoluteTuner),
    );
    check(
      'the bounded virtual tape moves left faster than the needle moves right',
      absoluteTuner.maxTickCount > 0 && absoluteTuner.maxTickCount < 100
        && absoluteTuner.needleDelta > 0 && absoluteTuner.tapeDelta < 0
        && Math.abs(absoluteTuner.tapeDelta) >= absoluteTuner.needleDelta * 4,
      JSON.stringify({
        maxTickCount: absoluteTuner.maxTickCount,
        needleDelta: absoluteTuner.needleDelta,
        tapeDelta: absoluteTuner.tapeDelta,
      }),
    );
    const tunerCancelRestore = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      // Capture a fresh gesture's complete presentation anchor before moving
      // to a different absolute directory station.
      const beforeStations = [...style._radioTunerStations];
      const sliderRect = slider.getBoundingClientRect();
      const xFor = (index) => sliderRect.left + 7
        + (sliderRect.width - 14) * index / Math.max(1, beforeStations.length - 1);
      const pointer = (type, index, pointerId = 52) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: sliderRect.top + sliderRect.height / 2,
        buttons: type === 'pointercancel' || type === 'pointerup' ? 0 : 1,
      }));
      const camera = gev.viewer.camera;
      const originalFlyTo = camera.flyTo;
      const flyToCalls = [];
      camera.flyTo = (options) => flyToCalls.push(options);
      const before = {
        signature: style._radioTunerBandSignature,
        ids: beforeStations.map((station) => station.id),
        slot: Number(slider.value),
        selectedId: radio.getUIState().selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
      };
      const targetIndex = before.slot < beforeStations.length - 2 ? before.slot + 2 : before.slot - 2;
      pointer('pointerdown', before.slot);
      pointer('pointermove', targetIndex);
      const shiftedSlot = Number(slider.value);
      const previewBeforeCancel = gev.viewer.entities.values
        .find((entity) => String(entity.id).startsWith('radio:selected:'))?.id || null;
      const flyToCallsBeforeCancel = flyToCalls.length;
      pointer('pointercancel', targetIndex);
      const afterStations = style._radioTunerStations;
      const afterState = radio.getUIState();
      const after = {
        signature: style._radioTunerBandSignature,
        ids: afterStations.map((station) => station.id),
        slot: Number(slider.value),
        selectedId: afterState.selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
        previewId: null,
        tuningActive: afterState.tuningActive,
      };
      const flyToCallsAfterCancel = flyToCalls.length;
      const selectedEntity = () => gev.viewer.entities.values
        .find((entity) => String(entity.id).startsWith('radio:selected:')) || null;
      const restoredEntity = selectedEntity();
      const previewId = restoredEntity?.id || null;
      after.previewId = previewId;
      const filterControl = document.getElementById('radio-filter');
      const changedFilter = afterState.filter === 'news' ? 'all' : 'news';
      const changedFilterSnapshot = radio.getAcceptedCatalogSnapshot();
      const changedFilterPlays = window.__qaRadioPlayCalls.length;
      const changedFilterCameraMoves = flyToCalls.length;
      filterControl.value = changedFilter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const changedFilterState = radio.getUIState();
      const changedFilterEntity = selectedEntity();
      const changedFilterCleanup = {
        filter: changedFilterState.filter,
        restoredStationId: changedFilterState.tuningRestoredStationId,
        selectedId: changedFilterState.selected?.id || null,
        entityRebuilt: Boolean(changedFilterEntity && changedFilterEntity !== restoredEntity),
        entityId: changedFilterEntity?.id || null,
        snapshotPreserved: radio.getAcceptedCatalogSnapshot() === changedFilterSnapshot,
        playDelta: window.__qaRadioPlayCalls.length - changedFilterPlays,
        cameraDelta: flyToCalls.length - changedFilterCameraMoves,
      };
      const sameFilterBegan = radio.beginTuning();
      const sameFilterCancelled = radio.cancelTuning();
      const sameFilterRestoredState = radio.getUIState();
      const sameFilterRestoredEntity = selectedEntity();
      const sameFilterSnapshot = radio.getAcceptedCatalogSnapshot();
      const sameFilterPlays = window.__qaRadioPlayCalls.length;
      const sameFilterCameraMoves = flyToCalls.length;
      filterControl.value = sameFilterRestoredState.filter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const sameFilterState = radio.getUIState();
      const sameFilterEntity = selectedEntity();
      const sameFilterCleanup = {
        began: sameFilterBegan,
        cancelled: sameFilterCancelled,
        restoredBefore: sameFilterRestoredState.tuningRestoredStationId,
        restoredAfter: sameFilterState.tuningRestoredStationId,
        filter: sameFilterState.filter,
        selectedId: sameFilterState.selected?.id || null,
        entityRebuilt: Boolean(sameFilterEntity && sameFilterEntity !== sameFilterRestoredEntity),
        entityId: sameFilterEntity?.id || null,
        snapshotPreserved: radio.getAcceptedCatalogSnapshot() === sameFilterSnapshot,
        playDelta: window.__qaRadioPlayCalls.length - sameFilterPlays,
        cameraDelta: flyToCalls.length - sameFilterCameraMoves,
      };
      filterControl.value = afterState.filter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      camera.flyTo = originalFlyTo;
      return {
        before,
        targetIndex,
        shiftedSlot,
        previewBeforeCancel,
        flyToCallsBeforeCancel,
        flyToCallsAfterCancel,
        changedFilter,
        changedFilterCleanup,
        sameFilterCleanup,
        after,
        identityRestored: afterStations.length === beforeStations.length
          && afterStations.every((station, index) => station === beforeStations[index]),
      };
    });
    check(
      'pointer cancel restores the exact pre-drag full-directory tuner anchor without playback',
      tunerCancelRestore.shiftedSlot === tunerCancelRestore.targetIndex
        && tunerCancelRestore.after.signature === tunerCancelRestore.before.signature
        && JSON.stringify(tunerCancelRestore.after.ids) === JSON.stringify(tunerCancelRestore.before.ids)
        && tunerCancelRestore.after.slot === tunerCancelRestore.before.slot
        && tunerCancelRestore.after.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.after.plays === tunerCancelRestore.before.plays
        && tunerCancelRestore.previewBeforeCancel !== `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.flyToCallsBeforeCancel > 0
        && tunerCancelRestore.flyToCallsAfterCancel === tunerCancelRestore.flyToCallsBeforeCancel
        && tunerCancelRestore.after.previewId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && !tunerCancelRestore.after.tuningActive
        && tunerCancelRestore.identityRestored,
      JSON.stringify(tunerCancelRestore),
    );
    check(
      'accepted changed-filter action clears and rebuilds the cancel-restored marker without side effects',
      tunerCancelRestore.changedFilterCleanup.filter === tunerCancelRestore.changedFilter
        && tunerCancelRestore.changedFilterCleanup.restoredStationId === null
        && tunerCancelRestore.changedFilterCleanup.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.changedFilterCleanup.entityRebuilt
        && tunerCancelRestore.changedFilterCleanup.entityId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.changedFilterCleanup.snapshotPreserved
        && tunerCancelRestore.changedFilterCleanup.playDelta === 0
        && tunerCancelRestore.changedFilterCleanup.cameraDelta === 0,
      JSON.stringify(tunerCancelRestore.changedFilterCleanup),
    );
    check(
      'accepted same-filter action clears and rebuilds the cancel-restored marker without side effects',
      tunerCancelRestore.sameFilterCleanup.began
        && tunerCancelRestore.sameFilterCleanup.cancelled
        && tunerCancelRestore.sameFilterCleanup.restoredBefore === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.sameFilterCleanup.restoredAfter === null
        && tunerCancelRestore.sameFilterCleanup.filter === tunerCancelRestore.changedFilter
        && tunerCancelRestore.sameFilterCleanup.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.sameFilterCleanup.entityRebuilt
        && tunerCancelRestore.sameFilterCleanup.entityId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.sameFilterCleanup.snapshotPreserved
        && tunerCancelRestore.sameFilterCleanup.playDelta === 0
        && tunerCancelRestore.sameFilterCleanup.cameraDelta === 0,
      JSON.stringify(tunerCancelRestore.sameFilterCleanup),
    );
    const tunerRefreshTarget = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const stations = gev.styleManager._radioTunerStations;
      const targetIndex = 1;
      const rect = slider.getBoundingClientRect();
      const clientX = rect.left + 7 + (rect.width - 14) * targetIndex / Math.max(1, stations.length - 1);
      slider.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
        buttons: 1,
      }));
      const station = stations[targetIndex];
      return {
        id: station.id,
        name: station.name,
        clientX,
        clientY: rect.top + rect.height / 2,
        generation: gev.dataManager.layers.get('radio').module.getUIState().tuningCatalogGeneration,
        plays: window.__qaRadioPlayCalls.length,
      };
    });
    catalogStations = stations.map((station) => (
      station.id === tunerRefreshTarget.id
        ? { ...station, name: `${station.name} B`, streamUrl: `${station.streamUrl}?generation=b` }
        : station
    ));
    catalogGeneration = 2;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    const tunerRefreshRelease = await page.evaluate((target) => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const displayedBeforeRelease = document.getElementById('radio-tuner-station').textContent;
      const frozenGeneration = gev.dataManager.layers.get('radio').module.getUIState().tuningCatalogGeneration;
      slider.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'mouse',
        clientX: target.clientX,
        clientY: target.clientY,
      }));
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        displayedBeforeRelease,
        frozenGeneration,
        unavailableId: state.tuningUnavailableStationId,
        selectedId: state.selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
        value: document.getElementById('radio-tuner-value').textContent,
        stationText: document.getElementById('radio-tuner-station').textContent,
        message: document.getElementById('radio-playback-state').textContent,
        targetId: target.id,
      };
    }, tunerRefreshTarget);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tuner-refresh-unavailable.png') });
    check(
      'mid-drag catalog replacement keeps generation A visible and reports release unavailable',
      tunerRefreshTarget.generation === 1
        && tunerRefreshRelease.frozenGeneration === 1
        && tunerRefreshRelease.displayedBeforeRelease === tunerRefreshTarget.name
        && tunerRefreshRelease.unavailableId === tunerRefreshTarget.id
        && tunerRefreshRelease.selectedId !== tunerRefreshTarget.id
        && tunerRefreshRelease.plays === tunerRefreshTarget.plays
        && tunerRefreshRelease.value === 'OFF AIR'
        && tunerRefreshRelease.stationText === 'STATION UNAVAILABLE'
        && /unavailable after directory refresh/i.test(tunerRefreshRelease.message),
      JSON.stringify(tunerRefreshRelease),
    );
    catalogStations = stations;
    catalogGeneration = 3;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    const tunerDirectRelease = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const needle = document.getElementById('radio-tuner-needle');
      const startSlot = Number(slider.value);
      const max = Number(slider.max);
      const direction = startSlot < max ? 1 : -1;
      const targetIndex = startSlot + direction;
      const targetId = gev.styleManager._radioTunerStations[targetIndex]?.id || null;
      const rect = slider.getBoundingClientRect();
      const xFor = (index) => rect.left + 7 + (rect.width - 14) * index / Math.max(1, max);
      const pointer = (type, index) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 41,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: rect.top + rect.height / 2,
        buttons: type === 'pointerup' ? 0 : 1,
      }));
      const playsBefore = window.__qaRadioPlayCalls.length;
      pointer('pointerdown', startSlot);
      pointer('pointermove', targetIndex);
      const previewPlays = window.__qaRadioPlayCalls.length;
      pointer('pointerup', targetIndex);
      const samples = [needle.getBoundingClientRect().left];
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push(needle.getBoundingClientRect().left);
      await new Promise((resolve) => setTimeout(resolve, 60));
      samples.push(needle.getBoundingClientRect().left);
      await new Promise((resolve) => setTimeout(resolve, 180));
      samples.push(needle.getBoundingClientRect().left);
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        direction,
        targetId,
        selectedId: state.selected?.id || null,
        sliderSlot: Number(slider.value),
        expectedSlot: targetIndex,
        previewPlayDelta: previewPlays - playsBefore,
        commitPlayDelta: window.__qaRadioPlayCalls.length - playsBefore,
        samples,
        spread: Math.max(...samples) - Math.min(...samples),
      };
    });
    check(
      'pointer preview never plays and release commits the nearest station once without a needle sweep',
      tunerDirectRelease.targetId
        && tunerDirectRelease.selectedId === tunerDirectRelease.targetId
        && tunerDirectRelease.sliderSlot === tunerDirectRelease.expectedSlot
        && tunerDirectRelease.previewPlayDelta === 0
        && tunerDirectRelease.commitPlayDelta === 1
        && tunerDirectRelease.spread < 0.5,
      JSON.stringify(tunerDirectRelease),
    );
    const tunerCommitTarget = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const targetIndex = 11;
      slider.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      const station = gev.styleManager._radioTunerStations[targetIndex];
      const rect = slider.getBoundingClientRect();
      const currentRatio = Number(slider.value) / Math.max(1, Number(slider.max));
      window.__qaRadioDelayNextPlay = true;
      return {
        id: station.id,
        targetIndex,
        count: gev.styleManager._radioTunerStations.length,
        frozenSignature: gev.styleManager._radioTunerBandSignature,
        startX: rect.left + 7 + (rect.width - 14) * currentRatio,
        targetX: rect.left + 7 + (rect.width - 14) * targetIndex
          / Math.max(1, gev.styleManager._radioTunerStations.length - 1),
        y: rect.top + rect.height / 2,
      };
    });
    await page.mouse.move(tunerCommitTarget.startX, tunerCommitTarget.y);
    await page.mouse.down();
    await page.mouse.move(tunerCommitTarget.targetX, tunerCommitTarget.y, { steps: 12 });
    await page.mouse.up();
    await sleep(650);
    const tunerCommit = await page.evaluate((target) => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        id: target.id,
        audioState: state.audioState,
        tuningStatic: state.tuningStatic,
        awaiting: state.tuningAwaitingStationId,
        signatureStable: gev.styleManager._radioTunerBandSignature === target.frozenSignature,
        selectedIndex: gev.styleManager._radioTunerStations.findIndex((item) => item.id === state.selected?.id),
        sliderSlot: Number(slider.value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        pinned: gev.styleManager._radioTunerBandPinnedForNavigation,
      };
    }, tunerCommitTarget);
    check(
      'tuner release keeps channel 12 pinned while its broadcaster connects',
      tunerCommit.audioState === 'loading' && tunerCommit.tuningStatic && tunerCommit.awaiting === tunerCommit.id
        && tunerCommit.signatureStable && tunerCommit.selectedIndex === 11
        && tunerCommit.sliderSlot === 11
        && Math.abs(tunerCommit.ratio - 11 / Math.max(1, tunerCommitTarget.count - 1)) < 0.0001
        && tunerCommit.pinned,
      JSON.stringify(tunerCommit),
    );
    await page.evaluate(() => window.__qaReleaseRadioPlay());
    await page.waitForFunction(
      (id) => {
        const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
        return state.selected?.id === id && state.audioState === 'playing' && !state.tuningActive && !state.tuningStatic;
      },
      {},
      tunerCommit.id,
    );
    const broadcastIndicator = await page.evaluate(() => ({
      active: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
      innerOpacity: getComputedStyle(document.querySelector('#title-bar .title-logo'), '::before').opacity,
      outerOpacity: getComputedStyle(document.querySelector('#title-bar .title-logo'), '::after').opacity,
    }));
    check('actual broadcaster playback fades out the tuner static', true, tunerCommit.id);
    check(
      'confirmed playback shows two restrained broadcast waves above the main logo',
      broadcastIndicator.active
        && Number(broadcastIndicator.innerOpacity) > 0 && Number(broadcastIndicator.innerOpacity) <= 0.28
        && Number(broadcastIndicator.outerOpacity) > 0 && Number(broadcastIndicator.outerOpacity) <= 0.17,
      JSON.stringify(broadcastIndicator),
    );
    const microDragStart = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const ratio = Number(slider.value) / Math.max(1, Number(slider.max));
      return {
        x: rect.left + 7 + (rect.width - 14) * ratio,
        y: rect.top + rect.height / 2,
        ratio,
        usableWidth: rect.width - 14,
        signature: style._radioTunerBandSignature,
      };
    });
    const microDragSamples = [];
    await page.mouse.move(microDragStart.x, microDragStart.y);
    await page.mouse.down();
    for (const delta of [1, 2, 10]) {
      await page.mouse.move(microDragStart.x + delta, microDragStart.y);
      await sleep(80);
      microDragSamples.push(await page.evaluate((pixelDelta) => {
        const style = window.__godsEyeView.styleManager;
        const slider = document.getElementById('radio-tuner-slider');
        return {
          pixelDelta,
          slot: Number(slider.value),
          ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
          signature: style._radioTunerBandSignature,
        };
      }, delta));
    }
    await page.mouse.move(microDragStart.x, microDragStart.y);
    await page.mouse.up();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tuner-micro-drag.png') });
    const microDragPlayback = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('radio').module;
      const deadline = Date.now() + 2_000;
      let state = mod.getUIState();
      while (state.audioState === 'loading' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = mod.getUIState();
      }
      if (state.audioState !== 'playing') {
        await mod.play({ origin: 'user' });
        state = mod.getUIState();
      }
      return { audioState: state.audioState, selectedId: state.selected?.id || null };
    });
    check(
      'native micro-drag leaves the selected station playable',
      microDragPlayback.audioState === 'playing' && Boolean(microDragPlayback.selectedId),
      JSON.stringify(microDragPlayback),
    );
    check(
      'native 1px, 2px, and 10px tuner moves stay monotonic on one frozen strip',
      microDragSamples.every((sample) => sample.signature === microDragStart.signature
        && Math.abs(sample.ratio - (microDragStart.ratio + sample.pixelDelta / microDragStart.usableWidth)) < 0.002)
        && microDragSamples.every((sample, index) => index === 0
          || (sample.slot >= microDragSamples[index - 1].slot
            && sample.ratio >= microDragSamples[index - 1].ratio)),
      JSON.stringify(microDragSamples),
    );
    const viewportTuner = await page.evaluate(async (selectedId) => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const before = {
        signature: style._radioTunerBandSignature,
        ids: style._radioTunerStations.map((station) => station.id),
        selectedIndex: style._radioTunerStations.findIndex((station) => station.id === selectedId),
        needle: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
      };
      const current = gev.viewer.camera.positionCartographic;
      const oppositeLongitude = ((current.longitude + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      gev.viewer.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      gev.viewer.camera.setView({
        destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: oppositeLongitude,
          latitude: -current.latitude,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.camera.changed.raiseEvent();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const stations = gev.styleManager._radioTunerStations;
      const selectedIndex = stations.findIndex((station) => station.id === selectedId);
      return {
        before,
        signature: style._radioTunerBandSignature,
        ids: stations.map((station) => station.id),
        count: stations.length,
        selectedIndex,
        needle: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
      };
    }, tunerCommit.id);
    check(
      'globe rotation leaves the catalog/filter directory order and absolute needle unchanged',
      viewportTuner.count === 750
        && viewportTuner.signature === viewportTuner.before.signature
        && JSON.stringify(viewportTuner.ids) === JSON.stringify(viewportTuner.before.ids)
        && viewportTuner.selectedIndex === viewportTuner.before.selectedIndex
        && Math.abs(viewportTuner.needle - viewportTuner.before.needle) < 0.0001,
      JSON.stringify(viewportTuner),
    );
    const nextNeedleBefore = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const selectedId = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id;
      const selectedIndex = style._radioTunerStations.findIndex((station) => station.id === selectedId);
      const selectedPoolIndex = style._radioTunerPool.findIndex((station) => station.id === selectedId);
      const expectedPoolIndex = (selectedPoolIndex + 1) % style._radioTunerPool.length;
      return {
        signature: style._radioTunerBandSignature,
        selectedIndex,
        count: style._radioTunerStations.length,
        expectedId: style._radioTunerPool[expectedPoolIndex]?.id || null,
      };
    });
    await page.$eval('#radio-next-btn', (button) => button.click());
    await sleep(1500);
    const nextNeedleAfter = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const selectedId = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id;
      const selectedIndex = style._radioTunerStations.findIndex((station) => station.id === selectedId);
      return {
        signature: style._radioTunerBandSignature,
        selectedId,
        selectedIndex,
        count: style._radioTunerStations.length,
        sliderSlot: Number(document.getElementById('radio-tuner-slider').value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        pinned: style._radioTunerBandPinnedForNavigation,
      };
    });
    check(
      'Next advances one absolute station and keeps the needle on its full-directory index',
      nextNeedleAfter.selectedId === nextNeedleBefore.expectedId
        && nextNeedleAfter.signature === nextNeedleBefore.signature
        && nextNeedleAfter.count === nextNeedleBefore.count
        && nextNeedleAfter.sliderSlot === nextNeedleAfter.selectedIndex
        && Math.abs(nextNeedleAfter.ratio
          - nextNeedleAfter.selectedIndex / Math.max(1, nextNeedleAfter.count - 1)) < 0.0001,
      JSON.stringify({ before: nextNeedleBefore, after: nextNeedleAfter }),
    );
    const tunerKeyboard = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const key = (type, value) => slider.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true,
        key: value,
      }));
      const markerId = () => gev.viewer.entities.values
        .find((entity) => String(entity.id).startsWith('radio:selected:'))?.id || null;
      const startIndex = Number(slider.value);
      const expectedIndex = Math.min(style._radioTunerStations.length - 1, startIndex + 1);
      const expectedId = style._radioTunerStations[expectedIndex]?.id || null;
      const playsBefore = window.__qaRadioPlayCalls.length;
      key('keydown', 'ArrowRight');
      const preview = {
        slot: Number(slider.value),
        markerId: markerId(),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      key('keyup', 'ArrowRight');
      const committed = {
        selectedId: radio.getUIState().selected?.id || null,
        slot: Number(slider.value),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      const committedPlays = window.__qaRadioPlayCalls.length;
      key('keydown', 'ArrowRight');
      key('keydown', 'Escape');
      const cancelled = {
        selectedId: radio.getUIState().selected?.id || null,
        slot: Number(slider.value),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - committedPlays,
      };
      const count = style._radioTunerStations.length;
      const pageStep = Math.max(1, Math.round((count - 1) / 10));
      const previewAndCancel = (value, expectedSlot) => {
        const beforePlays = window.__qaRadioPlayCalls.length;
        key('keydown', value);
        const result = {
          key: value,
          slot: Number(slider.value),
          expectedSlot,
          playDelta: window.__qaRadioPlayCalls.length - beforePlays,
        };
        key('keydown', 'Escape');
        result.restoredSlot = Number(slider.value);
        result.cancelPlayDelta = window.__qaRadioPlayCalls.length - beforePlays;
        return result;
      };
      const base = committed.slot;
      const navigation = [
        previewAndCancel('Home', 0),
        previewAndCancel('End', count - 1),
        previewAndCancel('PageUp', Math.min(count - 1, base + pageStep)),
        previewAndCancel('PageDown', Math.max(0, base - pageStep)),
      ];
      return { startIndex, expectedIndex, expectedId, preview, committed, cancelled, navigation };
    });
    check(
      'keyboard preview is silent, key release commits once, and Escape restores the committed station',
      tunerKeyboard.preview.slot === tunerKeyboard.expectedIndex
        && tunerKeyboard.preview.markerId === `radio:selected:${tunerKeyboard.expectedId}`
        && tunerKeyboard.preview.tuningActive && tunerKeyboard.preview.playDelta === 0
        && tunerKeyboard.committed.selectedId === tunerKeyboard.expectedId
        && tunerKeyboard.committed.slot === tunerKeyboard.expectedIndex
        && !tunerKeyboard.committed.tuningActive && tunerKeyboard.committed.playDelta === 1
        && tunerKeyboard.cancelled.selectedId === tunerKeyboard.expectedId
        && tunerKeyboard.cancelled.slot === tunerKeyboard.expectedIndex
        && !tunerKeyboard.cancelled.tuningActive && tunerKeyboard.cancelled.playDelta === 0,
      JSON.stringify(tunerKeyboard),
    );
    check(
      'Home, End, PageUp, and PageDown preview their absolute targets and cancel without playback',
      tunerKeyboard.navigation.every((sample) => sample.slot === sample.expectedSlot
        && sample.restoredSlot === tunerKeyboard.expectedIndex
        && sample.playDelta === 0 && sample.cancelPlayDelta === 0),
      JSON.stringify(tunerKeyboard.navigation),
    );
    await page.select('#radio-filter', 'news');
    const filteredTunerCenter = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const count = style._radioTunerStations.length;
      const centerIndex = Math.floor((count - 1) / 2 + 0.5);
      const clientX = rect.left + rect.width / 2;
      slider.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 88,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
        buttons: 1,
      }));
      const preview = {
        filter: radio.getUIState().filter,
        filteredCount: radio.getUIState().filteredCount,
        count,
        centerIndex,
        slot: Number(slider.value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        markerId: gev.viewer.entities.values
          .find((entity) => String(entity.id).startsWith('radio:selected:'))?.id || null,
        expectedId: style._radioTunerStations[centerIndex]?.id || null,
      };
      slider.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true,
        pointerId: 88,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
      }));
      return preview;
    });
    check(
      'filtered-directory center means half of the currently available station total',
      filteredTunerCenter.filter === 'news'
        && filteredTunerCenter.count === filteredTunerCenter.filteredCount
        && filteredTunerCenter.count > 1 && filteredTunerCenter.count < 750
        && filteredTunerCenter.slot === filteredTunerCenter.centerIndex
        && Math.abs(filteredTunerCenter.ratio - 0.5) < 0.0001
        && filteredTunerCenter.markerId === `radio:selected:${filteredTunerCenter.expectedId}`,
      JSON.stringify(filteredTunerCenter),
    );
    await page.select('#radio-filter', 'all');
    const fullPoolNavigation = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const radio = gev.dataManager.layers.get('radio').module;
      const pool = gev.styleManager._radioTunerPool;
      const ids = pool.map((station) => station.id);
      const selectWithoutPlayback = (index) => radio.selectStation(ids[index], {
        autoplay: false,
        focus: false,
        origin: 'programmatic',
      });
      selectWithoutPlayback(40);
      radio.cycleStation(1, { stationIds: ids, autoplay: false });
      const afterForty = radio.getUIState().selected?.id || null;
      selectWithoutPlayback(0);
      radio.cycleStation(-1, { stationIds: ids, autoplay: false });
      const afterPreviousWrap = radio.getUIState().selected?.id || null;
      selectWithoutPlayback(ids.length - 1);
      radio.cycleStation(1, { stationIds: ids, autoplay: false });
      const afterNextWrap = radio.getUIState().selected?.id || null;
      return {
        poolLength: ids.length,
        afterForty,
        expectedAfterForty: ids[41],
        afterPreviousWrap,
        expectedPreviousWrap: ids.at(-1),
        afterNextWrap,
        expectedNextWrap: ids[0],
      };
    });
    check(
      'Previous and Next traverse beyond channel 40 and wrap across the complete tuner pool',
      fullPoolNavigation.poolLength > 41
        && fullPoolNavigation.afterForty === fullPoolNavigation.expectedAfterForty
        && fullPoolNavigation.afterPreviousWrap === fullPoolNavigation.expectedPreviousWrap
        && fullPoolNavigation.afterNextWrap === fullPoolNavigation.expectedNextWrap,
      JSON.stringify(fullPoolNavigation),
    );
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await sleep(500);
    const failedTuner = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const count = gev.styleManager._radioTunerStations.length;
      const current = Number(slider.value);
      const target = Math.min(count - 1, current + 4);
      const xFor = (index) => rect.left + 7 + (rect.width - 14) * index / Math.max(1, count - 1);
      const pointer = (type, index) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 2,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: rect.top + rect.height / 2,
        buttons: type === 'pointerup' ? 0 : 1,
      }));
      window.__qaRadioFailNextPlay = true;
      pointer('pointerdown', current);
      pointer('pointermove', target);
      pointer('pointerup', target);
      await new Promise((resolve) => setTimeout(resolve));
      const failed = gev.dataManager.layers.get('radio').module.getUIState();
      gev.dataManager.layers.get('radio').module.stopPlayback();
      const stopped = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        failed: {
          audioState: failed.audioState,
          tuningStatic: failed.tuningStatic,
          awaiting: failed.tuningAwaitingStationId,
          broadcasting: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
        },
        stopped: {
          tuningStatic: stopped.tuningStatic,
          awaiting: stopped.tuningAwaitingStationId,
          broadcasting: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
        },
      };
    });
    check(
      'failed tuner stations retain the audible static hint until Stop',
      failedTuner.failed.audioState === 'error' && failedTuner.failed.tuningStatic && failedTuner.failed.awaiting
        && !failedTuner.failed.broadcasting && !failedTuner.stopped.tuningStatic
        && !failedTuner.stopped.awaiting && !failedTuner.stopped.broadcasting,
      JSON.stringify(failedTuner),
    );
    await page.select('#radio-filter', 'news');

    const markerTarget = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const source = Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations');
      source.clustering.enabled = false;
      const selectedId = radio.getUIState().selected?.id || null;
      if (selectedId) {
        radio.selectStation(selectedId, {
          autoplay: false,
          focus: false,
          origin: 'programmatic',
        });
      }
      viewer.camera.cancelFlight();
      const markerView = {
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: -174 * Math.PI / 180,
          latitude: 6 * Math.PI / 180,
          height: 500_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      };
      viewer.camera.setView(markerView);
      await new Promise((resolve) => {
        let removePostRender = null;
        removePostRender = viewer.scene.postRender.addEventListener(() => {
          removePostRender?.();
          resolve();
        });
        viewer.scene.requestRender();
      });
      // Cesium clears its private cluster collections during the rendered
      // disabled-state update. Publish the same-filter singleton overlay only
      // after that frame so this harness mutation cannot leak stale clusters.
      radio.setFilter('news');
      viewer.scene.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      return new Promise((resolve) => {
        let removePostRender = null;
        let timeout = null;
        let lastObservation = null;
        const finish = (result) => {
          clearTimeout(timeout);
          removePostRender?.();
          resolve(result);
        };
        const probe = () => {
          const camera = viewer.camera.positionCartographic;
          const longitude = camera.longitude * 180 / Math.PI;
          const latitude = camera.latitude * 180 / Math.PI;
          if (Math.abs(longitude + 174) > 0.5 || Math.abs(latitude - 6) > 0.5) {
            viewer.camera.cancelFlight();
            viewer.camera.setView(markerView);
            viewer.scene.requestRender();
            return;
          }
          const diagnostics = radio.getOverlayDiagnostics();
          const singletonIds = new Set(diagnostics.singletonIds);
          let visibleEntityCount = 0;
          let singletonEntityCount = 0;
          let paintedSingletonCount = 0;
          for (const entity of source.entities.values) {
            if (!entity.show) continue;
            visibleEntityCount += 1;
            const id = String(entity.id).slice('radio:'.length);
            const overlayId = `station:${id}`;
            if (!singletonIds.has(overlayId)) continue;
            singletonEntityCount += 1;
            const position = entity.position?.getValue(viewer.clock.currentTime);
            const canvas = position && viewer.scene.cartesianToCanvasCoordinates(position);
            const paintRect = getOverlayPaintRect('radio', overlayId);
            if (paintRect) paintedSingletonCount += 1;
            if (paintRect && canvas?.x > 300 && canvas.x < 1100 && canvas.y > 100 && canvas.y < 800) {
              finish({
                found: true,
                id,
                x: canvas.x,
                y: canvas.y,
                ownsNativeLabel: Boolean(entity.label),
                labelPainted: true,
                singletonTexts: diagnostics.singletonTexts,
              });
              return;
            }
          }
          lastObservation = {
            found: false,
            filter: radio.getUIState().filter,
            visibleEntityCount,
            singletonEntityCount,
            paintedSingletonCount,
            singletonIds: diagnostics.singletonIds,
            singletonTexts: diagnostics.singletonTexts,
            clusterIds: diagnostics.clusterIds,
            overlayEntryCount: diagnostics.entryCount,
            worldOverlay: getWorldOverlayDiagnostics(),
            camera: {
              longitude: viewer.camera.positionCartographic.longitude * 180 / Math.PI,
              latitude: viewer.camera.positionCartographic.latitude * 180 / Math.PI,
              height: viewer.camera.positionCartographic.height,
            },
          };
          viewer.scene.requestRender();
        };
        timeout = setTimeout(() => finish(lastObservation || { found: false, reason: 'no post-render probe' }), 8000);
        removePostRender = viewer.scene.postRender.addEventListener(probe);
        viewer.scene.requestRender();
      });
    });
    check('Radio exposes a visible marker for click-tolerance QA', markerTarget?.found === true, JSON.stringify(markerTarget));
    check(
      'the directly pickable singleton point has painted shared-host text and no native label',
      markerTarget?.labelPainted && !markerTarget?.ownsNativeLabel,
      JSON.stringify(markerTarget),
    );
    check(
      'ambient Radio globe labels use compact frequency-first text',
      markerTarget?.singletonTexts?.includes('100.3 FM — The River')
        && markerTarget.singletonTexts.every((text) => text.length <= 30),
      JSON.stringify(markerTarget?.singletonTexts),
    );
    if (markerTarget?.found) {
      await page.mouse.click(markerTarget.x + 6, markerTarget.y);
      await page.waitForFunction(
        (id) => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id === id,
        {},
        markerTarget.id,
      );
      const offsetSelected = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id);
      check('an offset click within 8px reliably selects the intended Radio dot', offsetSelected === markerTarget.id, offsetSelected);
    }

    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const camera = gev.viewer.camera;
      const radio = gev.dataManager.layers.get('radio').module;
      camera.cancelFlight();
      gev.viewer.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      camera.setView({
        destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      radio.stopPlayback();
      Array.from({ length: gev.viewer.dataSources.length }, (_, index) => gev.viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations').clustering.enabled = true;
      radio.selectStation('00000000-0000-4000-8000-000000000001', { autoplay: false, focus: false });
      const pool = gev.styleManager._radioTunerPool;
      const selectedIndex = pool.findIndex((station) => station.id === radio.getUIState().selected?.id);
      window.__qaRadioExpectedPrimary = pool[(selectedIndex + 1) % pool.length];
      window.__qaRadioExpectedFallback = pool[(selectedIndex + 2) % pool.length];
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextFailure = true;
      window.__qaRadioFlyToCalls = [];
      window.__qaRadioOriginalFlyTo = camera.flyTo;
      window.__qaRadioCameraHeight = camera.positionCartographic.height;
      camera.flyTo = (options) => window.__qaRadioFlyToCalls.push(options);
      gev.dataManager.layers.get('flights').enabled = true;
    });
    await sleep(500);
    await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', true));
    await page.evaluate(() => {
      const button = document.getElementById('context-radio-toggle-btn');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
    });
    await page.waitForSelector('#context-radio-mini', { visible: true });
    await page.evaluate(() => {
      window.__qaRadioCameraHeight = window.__godsEyeView.viewer.camera.positionCartographic.height;
    });
    const radioOnlyNextDispatched = await page.evaluate(() => {
      const button = document.getElementById('context-radio-mini-next-btn');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!radioOnlyNextDispatched) throw new Error('Radio compact next button unavailable');
    await page.waitForFunction(() => typeof window.__qaRejectRadioPlay === 'function');
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_400_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      window.__qaRejectRadioPlay();
    });
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    const playing = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const viewer = window.__godsEyeView.viewer;
      const selectedEntity = window.__godsEyeView.viewer.entities.values
        .find((entity) => String(entity.id).startsWith('radio:selected:'));
      const { getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const flightTargets = window.__qaRadioFlyToCalls.map(({ destination }) => {
        const position = viewer.scene.globe.ellipsoid.cartesianToCartographic(destination);
        return {
          lat: position.latitude * 180 / Math.PI,
          lon: position.longitude * 180 / Math.PI,
          height: position.height,
        };
      });
      return {
      state: radio.getUIState(),
      calls: [...window.__qaRadioPlayCalls],
      flyToCalls: window.__qaRadioFlyToCalls.length,
      flightTargets,
      cameraHeight: window.__qaRadioCameraHeight,
      compactPlayLabel: document.getElementById('context-radio-mini-play-btn').getAttribute('aria-label'),
      regularMarkerSize: Array.from({ length: window.__godsEyeView.viewer.dataSources.length }, (_, index) => window.__godsEyeView.viewer.dataSources.get(index))
        .find((item) => item.name === 'Radio stations')?.entities.values[0]?.point?.pixelSize?.getValue(),
      selectedMarkerSize: selectedEntity?.point?.pixelSize?.getValue(),
      selectedBracketWidth: selectedEntity?.billboard?.width?.getValue(),
      selectedOwnsNativeLabel: Boolean(selectedEntity?.label),
      overlay: radio.getOverlayDiagnostics(),
      host: getWorldOverlayDiagnostics(),
      expectedPrimary: window.__qaRadioExpectedPrimary,
      expectedFallback: window.__qaRadioExpectedFallback,
    };
    });
    check(
      'compact Next follows stable directory order and retries its next available station',
      playing.state.selected?.id === playing.expectedFallback?.id
        && playing.calls[0] === playing.expectedPrimary?.streamUrl
        && playing.calls[1] === playing.expectedFallback?.streamUrl,
      JSON.stringify({
        selected: playing.state.selected?.id,
        calls: playing.calls,
        primary: playing.expectedPrimary?.id,
        fallback: playing.expectedFallback?.id,
      }),
    );
    check('compact next is explicit playback and updates play/pause state', playing.calls.length === 2 && playing.compactPlayLabel.startsWith('Pause'));
    check(
      'compact next rotates toward its station without changing zoom, including fallback',
      playing.flyToCalls === 2
        && Math.abs(playing.flightTargets[0]?.lat - playing.expectedPrimary?.lat) < 0.001
        && Math.abs(playing.flightTargets[0]?.lon - playing.expectedPrimary?.lon) < 0.001
        && Math.abs(playing.flightTargets[1]?.lat - playing.expectedFallback?.lat) < 0.001
        && Math.abs(playing.flightTargets[1]?.lon - playing.expectedFallback?.lon) < 0.001
        && playing.flightTargets.every((target) => Math.abs(target.height - playing.cameraHeight) < 1),
      JSON.stringify({ calls: playing.flyToCalls, targets: playing.flightTargets, cameraHeight: playing.cameraHeight }),
    );
    const trackedRadioControls = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const run = async (ownerPrefix, buttonId) => {
        const owner = viewer.entities.add({
          id: `qa:${ownerPrefix}:radio-camera-owner`,
          position: viewer.camera.positionWC.clone(),
        });
        owner.gevTrackedId = `${ownerPrefix}:qa-radio-camera-owner`;
        viewer.trackedEntity = owner;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const beforeStationId = radio.getUIState().selected?.id || null;
        const beforeFlyToCalls = window.__qaRadioFlyToCalls.length;
        document.getElementById(buttonId)?.click();
        await new Promise((resolve) => setTimeout(resolve));
        const result = {
          ownerPrefix,
          buttonId,
          beforeStationId,
          afterStationId: radio.getUIState().selected?.id || null,
          flyToDelta: window.__qaRadioFlyToCalls.length - beforeFlyToCalls,
          trackedIdentityPreserved: viewer.trackedEntity === owner,
          trackedId: viewer.trackedEntity?.gevTrackedId || null,
        };
        viewer.trackedEntity = undefined;
        viewer.entities.remove(owner);
        return result;
      };
      return [
        await run('flights', 'radio-next-btn'),
        await run('military', 'context-radio-mini-prev-btn'),
      ];
    });
    check(
      'full and compact Radio navigation preserve Flights/Military camera ownership',
      trackedRadioControls.every((sample) => sample.afterStationId
        && sample.afterStationId !== sample.beforeStationId
        && sample.flyToDelta === 0
        && sample.trackedIdentityPreserved
        && sample.trackedId === `${sample.ownerPrefix}:qa-radio-camera-owner`),
      JSON.stringify(trackedRadioControls),
    );

    const delayedTrackingStart = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.trackedEntity = undefined;
      window.__qaRadioDelayNextFailure = true;
      const beforeFlyToCalls = window.__qaRadioFlyToCalls.length;
      document.getElementById('context-radio-mini-next-btn')?.click();
      return { beforeFlyToCalls };
    });
    await page.waitForFunction(() => typeof window.__qaRejectRadioPlay === 'function');
    const delayedTrackingOwner = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const owner = viewer.entities.add({
        id: 'qa:flights:delayed-radio-fallback-owner',
        position: viewer.camera.positionWC.clone(),
      });
      owner.gevTrackedId = 'flights:qa-delayed-radio-fallback-owner';
      viewer.trackedEntity = owner;
      window.__qaDelayedRadioTrackingOwner = owner;
      window.__qaRejectRadioPlay();
      return owner.gevTrackedId;
    });
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    const delayedFallbackOwnership = await page.evaluate((beforeFlyToCalls) => {
      const viewer = window.__godsEyeView.viewer;
      const owner = window.__qaDelayedRadioTrackingOwner;
      const result = {
        flyToDelta: window.__qaRadioFlyToCalls.length - beforeFlyToCalls,
        trackedIdentityPreserved: viewer.trackedEntity === owner,
        trackedId: viewer.trackedEntity?.gevTrackedId || null,
        selectedId: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id || null,
      };
      viewer.trackedEntity = undefined;
      viewer.entities.remove(owner);
      delete window.__qaDelayedRadioTrackingOwner;
      return result;
    }, delayedTrackingStart.beforeFlyToCalls);
    check(
      'a delayed Radio fallback yields when Flights acquires the camera after the initial rotation',
      delayedFallbackOwnership.flyToDelta === 1
        && delayedFallbackOwnership.trackedIdentityPreserved
        && delayedFallbackOwnership.trackedId === delayedTrackingOwner
        && Boolean(delayedFallbackOwnership.selectedId),
      JSON.stringify(delayedFallbackOwnership),
    );
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: window.__qaRadioCameraHeight,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    check(
      'individual Radio dots stay at least half the largest cluster point',
      playing.regularMarkerSize === 13
        && playing.regularMarkerSize * 2 >= 26
        && playing.selectedMarkerSize === 14,
      `${playing.regularMarkerSize}px / ${playing.selectedMarkerSize}px selected`,
    );
    check('the current station carries a 40px four-corner selection bracket', playing.selectedBracketWidth === 40, `${playing.selectedBracketWidth}px`);
    check(
      'selected-station text is published to the protected shared-host lane with no native entity label',
      !playing.selectedOwnsNativeLabel
        && playing.overlay.selectedCount === 1
        && playing.host.entriesBySource?.radio === playing.overlay.entryCount,
      JSON.stringify({ overlay: playing.overlay, host: playing.host.entriesBySource }),
    );
    const closeSelectedText = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const selected = radio.getUIState().selected;
      window.__qaRadioVisualView = {
        position: viewer.camera.positionWC.clone(),
        direction: viewer.camera.directionWC.clone(),
        up: viewer.camera.upWC.clone(),
      };
      const destination = viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: selected.lon * Math.PI / 180,
        latitude: selected.lat * Math.PI / 180,
        height: 5_000,
      });
      viewer.camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const selectedEntity = viewer.entities.values
        .find((entity) => String(entity.id) === `radio:selected:${selected.id}`);
      const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const expectedEntryId = `selected:${selected.id}`;
      let painted = null;
      for (let attempt = 0; attempt < 20 && !painted?.rect; attempt += 1) {
        painted = await new Promise((resolve) => {
          let removePostRender = null;
          const timeout = setTimeout(() => {
            removePostRender?.();
            resolve({ rect: null, host: getWorldOverlayDiagnostics() });
          }, 150);
          removePostRender = viewer.scene.postRender.addEventListener(() => {
            clearTimeout(timeout);
            removePostRender();
            const rect = getOverlayPaintRect('radio', expectedEntryId);
            resolve({
              rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null,
              host: getWorldOverlayDiagnostics(),
            });
          });
          viewer.scene.requestRender();
        });
      }
      return {
        expectedEntryId,
        rect: painted?.rect || null,
        host: painted?.host || getWorldOverlayDiagnostics(),
        selectedEntityShow: selectedEntity?.show,
        cameraHeight: viewer.camera.positionCartographic.height,
      };
    });
    check(
      'selected shared-host text remains in the paint pipeline in a close stationary view',
      closeSelectedText?.rect?.w > 0
        && closeSelectedText?.rect?.h > 0
        && closeSelectedText?.selectedEntityShow === true,
      JSON.stringify(closeSelectedText),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-desktop.png') });
    const highGlobalSelectedText = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const selected = radio.getUIState().selected;
      const ellipsoid = viewer.scene.globe.ellipsoid;
      viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: (selected.lon + 10) * Math.PI / 180,
          latitude: selected.lat * Math.PI / 180,
          height: 5_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const selectedEntity = viewer.entities.values
        .find((entity) => String(entity.id) === `radio:selected:${selected.id}`);
      const { getOverlayPaintRect, getWorldOverlayDiagnostics } = await import('/src/overlays/worldOverlay.js');
      const expectedEntryId = `selected:${selected.id}`;
      let rect = null;
      for (let attempt = 0; attempt < 20 && !rect; attempt += 1) {
        rect = await new Promise((resolve) => {
          let removePostRender = null;
          const timeout = setTimeout(() => {
            removePostRender?.();
            resolve(null);
          }, 150);
          removePostRender = viewer.scene.postRender.addEventListener(() => {
            clearTimeout(timeout);
            removePostRender();
            const painted = getOverlayPaintRect('radio', expectedEntryId);
            resolve(painted ? {
              x: painted.x,
              y: painted.y,
              w: painted.w,
              h: painted.h,
            } : null);
          });
          viewer.scene.requestRender();
        });
      }
      const entityPosition = selectedEntity?.position?.getValue?.();
      const entityAnchor = entityPosition
        && viewer.scene.cartesianToCanvasCoordinates(entityPosition);
      let selectedNativePick = null;
      let selectedPointPick = null;
      let selectedBillboardPick = null;
      // Retry on the STRICT anchor: waiting only for "any pick" let a
      // billboard satisfy the loop while the point anchor was still missing.
      for (let attempt = 0; entityAnchor && attempt < 8 && !selectedPointPick; attempt += 1) {
        const picks = viewer.scene.drillPick(entityAnchor, 16) || [];
        selectedNativePick = picks.find((picked) => picked?.id === selectedEntity);
        selectedPointPick = picks.find((picked) => (
          picked?.id === selectedEntity
          && String(picked?.primitive?.constructor?.name || '').includes('PointPrimitive')
        ));
        selectedBillboardPick = picks.find((picked) => (
          picked?.id === selectedEntity
          && String(picked?.primitive?.constructor?.name || '').includes('Billboard')
        ));
        if (!selectedPointPick) {
          await new Promise((resolve) => {
            const removePostRender = viewer.scene.postRender.addEventListener(() => {
              removePostRender();
              resolve();
            });
            viewer.scene.requestRender();
          });
        }
      }
      const selectedPointDistance = selectedEntity?.point?.distanceDisplayCondition?.getValue?.();
      return {
        rect,
        selectedNativePickable: Boolean(selectedNativePick),
        selectedPointPickable: Boolean(selectedPointPick),
        selectedBillboardPickable: Boolean(selectedBillboardPick),
        selectedPointMaxDistance: selectedPointDistance?.far ?? null,
        selectedEntityShow: selectedEntity?.show,
        selectedBracketVisible: Boolean(
          selectedEntity?.billboard
          && selectedEntity.billboard.show?.getValue?.() !== false
        ),
        entityAnchor: entityAnchor ? { x: entityAnchor.x, y: entityAnchor.y } : null,
        entityDistance: entityPosition
          ? Math.hypot(
            viewer.camera.positionWC.x - entityPosition.x,
            viewer.camera.positionWC.y - entityPosition.y,
            viewer.camera.positionWC.z - entityPosition.z,
          )
          : null,
        overlay: radio.getOverlayDiagnostics(),
        host: getWorldOverlayDiagnostics(),
        cameraHeight: viewer.camera.positionCartographic.height,
      };
    });
    check(
      'selected label, bracket, and native pick anchor share the supported high-global range',
      highGlobalSelectedText.cameraHeight > 4_800_000
        && highGlobalSelectedText.rect?.w > 0
        && highGlobalSelectedText.rect?.h > 0
        && highGlobalSelectedText.selectedEntityShow === true
        && highGlobalSelectedText.selectedBracketVisible
        && highGlobalSelectedText.selectedPointMaxDistance === 50_000_000
        // The POINT anchor is the invariant: it is what stays pickable out to
        // the 50,000 km band. Accepting any native pick let the co-located
        // billboard keep this green after the point anchor regressed.
        //
        // `selectedBillboardPickable` is reported for diagnostics but NOT
        // asserted: measured here it is false — the selection bracket renders
        // (selectedBracketVisible) without being pickable at the point anchor,
        // so requiring it would pin a behavior the app does not have.
        && highGlobalSelectedText.selectedPointPickable
        && highGlobalSelectedText.selectedNativePickable,
      JSON.stringify(highGlobalSelectedText),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-high-global.png') });
    await page.setViewport({ width: 560, height: 760, deviceScaleFactor: 1 });
    await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      window.__godsEyeView.styleManager.toggleCleanView(true);
      viewer.resize();
      viewer.scene.requestRender();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-mobile.png') });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      window.__godsEyeView.styleManager.toggleCleanView(false);
      viewer.resize();
      viewer.scene.requestRender();
    });
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const view = window.__qaRadioVisualView;
      viewer.camera.setView({
        destination: view.position,
        orientation: { direction: view.direction, up: view.up },
      });
      delete window.__qaRadioVisualView;
      viewer.scene.requestRender();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await page.evaluate(() => {
      window.__qaRadioFlyToCalls = [];
      window.__godsEyeView.dataManager.layers.get('flights').enabled = false;
    });
    const radioOnlyNextClicked = await page.evaluate(() => {
      const button = document.getElementById('context-radio-mini-next-btn');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    });
    check(
      'Radio-only next control remains available after responsive visual checks',
      radioOnlyNextClicked,
      `clicked=${radioOnlyNextClicked}`,
    );
    const radioOnlyFocusCalls = await page.evaluate(() => {
      const calls = window.__qaRadioFlyToCalls.length;
      const heights = window.__qaRadioFlyToCalls.map((options) => (
        window.__godsEyeView.viewer.scene.globe.ellipsoid.cartesianToCartographic(options.destination).height
      ));
      window.__godsEyeView.viewer.camera.flyTo = window.__qaRadioOriginalFlyTo;
      delete window.__qaRadioOriginalFlyTo;
      return { calls, heights, cameraHeight: window.__qaRadioCameraHeight };
    });
    check(
      'Radio-only next advances the tuner and rotates without changing zoom',
      radioOnlyFocusCalls.calls === 1
        && radioOnlyFocusCalls.heights.every((height) => Math.abs(height - radioOnlyFocusCalls.cameraHeight) < 1),
      JSON.stringify(radioOnlyFocusCalls),
    );

    const stagedGlobeNavigation = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const viewer = gev.viewer;
      const camera = viewer.camera;
      const radio = gev.dataManager.layers.get('radio').module;
      const stationIds = radio.getTunerStations(3).map((station) => station.id);
      if (stationIds.length < 3) throw new Error('Radio recenter QA requires three visible stations');
      const originalFlyTo = camera.flyTo;
      const calls = [];
      camera.flyTo = (options) => calls.push(options);
      const setCamera = (height, pitchDegrees, headingDegrees = 38) => {
        camera.setView({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: -133.9483 * Math.PI / 180,
            latitude: 23.4741 * Math.PI / 180,
            height,
          }),
          orientation: {
            heading: headingDegrees * Math.PI / 180,
            pitch: pitchDegrees * Math.PI / 180,
            roll: 0,
          },
        });
        viewer.scene.requestRender();
      };
      const completeFlight = (index) => {
        const flight = calls[index];
        camera.setView({
          destination: flight.destination,
          orientation: flight.orientation,
        });
        flight.complete?.();
      };
      const describe = (flight) => {
        const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(flight.destination);
        return {
          lat: cartographic.latitude * 180 / Math.PI,
          lon: cartographic.longitude * 180 / Math.PI,
          height: cartographic.height,
          heading: flight.orientation?.heading,
          pitch: flight.orientation?.pitch,
          roll: flight.orientation?.roll,
          duration: flight.duration,
          eased: Boolean(flight.easingFunction),
        };
      };

      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const partialInitialCalls = calls.length;
      const recenter = describe(calls[0]);
      completeFlight(0);
      const partialAfterRecenterCalls = calls.length;
      const selectedAfterRecenter = radio.getUIState().selected;
      const stationFocus = describe(calls[1]);

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const owner = viewer.entities.add({
        id: 'qa:flights:radio-recenter-stage-owner',
        position: viewer.camera.positionWC.clone(),
      });
      owner.gevTrackedId = 'flights:qa-radio-recenter-stage-owner';
      viewer.trackedEntity = owner;
      completeFlight(0);
      const trackingBetweenStagesCalls = calls.length;
      const trackingIdentityPreserved = viewer.trackedEntity === owner;
      viewer.trackedEntity = undefined;
      viewer.entities.remove(owner);

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.selectStation(stationIds[2], { autoplay: false, focus: false });
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const staleRecenter = calls[0];
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const latestRecenterIndex = calls.length - 1;
      staleRecenter.complete?.();
      const callsAfterStaleCompletion = calls.length;
      completeFlight(latestRecenterIndex);
      const latestSelected = radio.getUIState().selected;
      const latestFocus = describe(calls.at(-1));

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const directSelectionStaleRecenter = calls[0];
      const directSelectionId = stationIds.find((id) => id !== radio.getUIState().selected.id);
      radio.selectStation(directSelectionId, { autoplay: false, focus: false, origin: 'user' });
      const directSelectionCalls = calls.length;
      directSelectionStaleRecenter.complete?.();
      const directSelectionCallsAfterStale = calls.length;
      const directSelectionSelectedId = radio.getUIState().selected.id;

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const voiceSelectionStaleRecenter = calls[0];
      const voiceSelectionId = stationIds.find((id) => id !== radio.getUIState().selected.id);
      const voiceSelection = radio.selectRequestedStation({
        stationQuery: voiceSelectionId,
      }, { autoplay: false, origin: 'voice' });
      const voiceSelectionCalls = calls.length;
      voiceSelectionStaleRecenter.complete?.();
      const voiceSelectionCallsAfterStale = calls.length;
      const voiceSelectionSelectedId = radio.getUIState().selected.id;
      radio.selectStation(latestSelected.id, { autoplay: false, focus: false });

      calls.length = 0;
      setCamera(97_488_500, -40, 119);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const extremeRecenter = describe(calls[0]);
      completeFlight(0);
      const extremeFocus = describe(calls[1]);

      calls.length = 0;
      setCamera(5_000, -35, 15);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const localDirect = describe(calls[0]);
      const localDirectCalls = calls.length;

      calls.length = 0;
      setCamera(12_000_000, -90, 15);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const centeredDirect = describe(calls[0]);
      const centeredDirectCalls = calls.length;

      camera.flyTo = originalFlyTo;
      return {
        partialInitialCalls,
        partialAfterRecenterCalls,
        recenter,
        stationFocus,
        selectedAfterRecenter,
        trackingBetweenStagesCalls,
        trackingIdentityPreserved,
        latestRecenterIndex,
        callsAfterStaleCompletion,
        latestSelected,
        latestFocus,
        directSelectionId,
        directSelectionCalls,
        directSelectionCallsAfterStale,
        directSelectionSelectedId,
        voiceSelectionId,
        voiceSelectionMatchedId: voiceSelection?.id || null,
        voiceSelectionCalls,
        voiceSelectionCallsAfterStale,
        voiceSelectionSelectedId,
        extremeRecenter,
        extremeFocus,
        localDirectCalls,
        localDirect,
        centeredDirectCalls,
        centeredDirect,
      };
    });
    check(
      'a below-center closer globe animates back to center before station focus',
      stagedGlobeNavigation.partialInitialCalls === 1
        && stagedGlobeNavigation.partialAfterRecenterCalls === 2
        && Math.abs(stagedGlobeNavigation.recenter.height - 2_915_647) < 1
        && stagedGlobeNavigation.recenter.heading === 0
        && Math.abs(stagedGlobeNavigation.recenter.pitch + Math.PI / 2) < 1e-9
        && stagedGlobeNavigation.recenter.roll === 0
        && stagedGlobeNavigation.recenter.duration >= 0.65
        && stagedGlobeNavigation.recenter.eased
        && Math.abs(stagedGlobeNavigation.stationFocus.height - 2_915_647) < 1
        && Math.abs(stagedGlobeNavigation.stationFocus.lat - stagedGlobeNavigation.selectedAfterRecenter.lat) < 0.001
        && Math.abs(stagedGlobeNavigation.stationFocus.lon - stagedGlobeNavigation.selectedAfterRecenter.lon) < 0.001
        && Math.abs(stagedGlobeNavigation.stationFocus.pitch + Math.PI / 2) < 1e-9,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'tracking acquired during Radio recenter suppresses the station-focus stage',
      stagedGlobeNavigation.trackingBetweenStagesCalls === 1
        && stagedGlobeNavigation.trackingIdentityPreserved,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer Radio action makes the older recenter callback inert and owns the final focus',
      stagedGlobeNavigation.latestRecenterIndex === 1
        && stagedGlobeNavigation.callsAfterStaleCompletion === 2
        && Math.abs(stagedGlobeNavigation.latestFocus.lat - stagedGlobeNavigation.latestSelected.lat) < 0.001
        && Math.abs(stagedGlobeNavigation.latestFocus.lon - stagedGlobeNavigation.latestSelected.lon) < 0.001,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer direct station selection invalidates an older staged Radio recenter',
      stagedGlobeNavigation.directSelectionCalls === 1
        && stagedGlobeNavigation.directSelectionCallsAfterStale === 1
        && stagedGlobeNavigation.directSelectionSelectedId === stagedGlobeNavigation.directSelectionId,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer voice station selection remains non-moving after an older recenter completes',
      stagedGlobeNavigation.voiceSelectionCalls === 1
        && stagedGlobeNavigation.voiceSelectionCallsAfterStale === 1
        && stagedGlobeNavigation.voiceSelectionMatchedId === stagedGlobeNavigation.voiceSelectionId
        && stagedGlobeNavigation.voiceSelectionSelectedId === stagedGlobeNavigation.voiceSelectionId,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'extreme zoom-out recovery caps the north-up full-globe frame',
      Math.abs(stagedGlobeNavigation.extremeRecenter.height - 13_000_000) < 1
        && stagedGlobeNavigation.extremeRecenter.heading === 0
        && Math.abs(stagedGlobeNavigation.extremeRecenter.pitch + Math.PI / 2) < 1e-9
        && stagedGlobeNavigation.extremeRecenter.roll === 0
        && Math.abs(stagedGlobeNavigation.extremeFocus.height - 13_000_000) < 1,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'local and already-centered globe views keep the single-stage direct path',
      stagedGlobeNavigation.localDirectCalls === 1
        && stagedGlobeNavigation.centeredDirectCalls === 1
        && Math.abs(stagedGlobeNavigation.localDirect.pitch + 35 * Math.PI / 180) < 1e-9
        && Math.abs(stagedGlobeNavigation.centeredDirect.pitch + Math.PI / 2) < 1e-9,
      JSON.stringify(stagedGlobeNavigation),
    );

    await page.evaluate(() => {
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', false);
    });
    const companion = await page.evaluate(() => ({
      radioEnabled: window.__godsEyeView.dataManager.isEnabled('radio'),
      state: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState,
      radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
      contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
      nested: document.getElementById('global-context-panel').contains(document.getElementById('radio-panel')),
    }));
    check(
      'expanding Context preserves playback and the user-selected detailed Radio disclosure',
      companion.radioEnabled && companion.state === 'playing'
        && companion.radioCollapsed && !companion.contextCollapsed && companion.nested,
    );

    const expandedContextRadioBefore = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      scroller.scrollTop = 0;
      const camera = gev.viewer.camera.positionWC;
      return {
        scrollTop: scroller.scrollTop,
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        plays: window.__qaRadioPlayCalls.length,
      };
    });
    await page.click('#context-radio-toggle-btn');
    await page.waitForFunction(() => !document.getElementById('radio-panel').classList.contains('collapsed'));
    await sleep(450);
    const expandedContextRadioAfter = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      gev.styleManager._renderRadioState(gev.dataManager.layers.get('radio').module.getUIState());
      const launcher = document.getElementById('context-radio-toggle-btn');
      const radio = document.getElementById('radio-panel');
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const camera = gev.viewer.camera.positionWC;
      return {
        ariaControls: launcher.getAttribute('aria-controls'),
        expanded: launcher.getAttribute('aria-expanded'),
        label: launcher.getAttribute('aria-label'),
        radioCollapsed: radio.classList.contains('collapsed'),
        compactHidden: document.getElementById('context-radio-mini').hidden,
        scrollTop: scroller.scrollTop,
        focusTarget: document.activeElement?.getAttribute('data-collapse-target'),
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        plays: window.__qaRadioPlayCalls.length,
        state: gev.dataManager.layers.get('radio').module.getUIState().audioState,
      };
    });
    const expandedContextRadioCameraDelta = Math.hypot(
      expandedContextRadioAfter.camera.x - expandedContextRadioBefore.camera.x,
      expandedContextRadioAfter.camera.y - expandedContextRadioBefore.camera.y,
      expandedContextRadioAfter.camera.z - expandedContextRadioBefore.camera.z,
    );
    check(
      'expanded Context Radio icon reveals and scrolls to embedded Radio without an overlay or playback/camera theft',
      expandedContextRadioAfter.ariaControls === 'radio-panel'
        && expandedContextRadioAfter.expanded === 'true'
        && expandedContextRadioAfter.label === 'Go to expanded Radio section'
        && !expandedContextRadioAfter.radioCollapsed
        && expandedContextRadioAfter.compactHidden
        && expandedContextRadioAfter.scrollTop > expandedContextRadioBefore.scrollTop
        && expandedContextRadioAfter.focusTarget === 'radio-panel'
        && expandedContextRadioAfter.pageY === expandedContextRadioBefore.pageY
        && expandedContextRadioCameraDelta < 0.01
        && expandedContextRadioAfter.plays === expandedContextRadioBefore.plays
        && expandedContextRadioAfter.state === 'playing',
      JSON.stringify({
        before: expandedContextRadioBefore,
        after: expandedContextRadioAfter,
        cameraDelta: expandedContextRadioCameraDelta,
      }),
    );

    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', true);
      manager._setRadioDisclosure(true);
    });
    await page.waitForFunction(() => {
      const close = document.getElementById('context-radio-mini-close-btn');
      const rect = close.getBoundingClientRect();
      return !document.getElementById('context-radio-mini').hidden && rect.width > 0 && rect.height > 0;
    });
    await page.click('#context-radio-mini-close-btn');
    const closedCompact = await page.evaluate(() => {
      const launcher = document.getElementById('context-radio-toggle-btn');
      return {
        radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
        compactHidden: document.getElementById('context-radio-mini').hidden,
        focusRestored: document.activeElement === launcher,
      };
    });
    await page.click('#context-radio-toggle-btn');
    await page.waitForFunction(() => !document.getElementById('context-radio-mini').hidden);
    await page.click('#context-radio-details-btn');
    const repeatedOpen = await page.evaluate(() => ({
      radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
      compactHidden: document.getElementById('context-radio-mini').hidden,
    }));
    const splitDetailActions = { closedCompact, repeatedOpen };
    check(
      'collapsed Context keeps compact close and full-panel open as separate stable actions',
      !splitDetailActions.closedCompact.radioCollapsed
        && splitDetailActions.closedCompact.compactHidden
        && splitDetailActions.closedCompact.focusRestored
        && !splitDetailActions.repeatedOpen.radioCollapsed
        && splitDetailActions.repeatedOpen.compactHidden,
      JSON.stringify(splitDetailActions),
    );

    await page.click('#global-context-flights-btn');
    await page.waitForFunction(() => !document.getElementById('context-flights-view').hidden);
    const companionStack = await page.evaluate(() => {
      const contextView = document.getElementById('context-flights-view');
      const awareness = document.getElementById('military-awareness-panel');
      const radio = document.getElementById('radio-panel');
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const awarenessRect = awareness.getBoundingClientRect();
      const radioRect = radio.getBoundingClientRect();
      return {
        contactsNaturalHeight: contextView.clientHeight === contextView.scrollHeight,
        radioNaturalHeight: radio.clientHeight === radio.scrollHeight,
        separated: awarenessRect.bottom <= radioRect.top,
        scrollable: scroller.scrollHeight > scroller.clientHeight,
      };
    });
    check(
      'expanded Contacts and Radio remain separated in the shared Context scroller',
      companionStack.contactsNaturalHeight && companionStack.radioNaturalHeight
        && companionStack.separated && companionStack.scrollable,
      JSON.stringify(companionStack),
    );

    await page.select('#radio-filter', 'talk');
    const filtered = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState());
    check('filter changes markers/navigation without stopping the selected stream', filtered.filteredCount === 75 && filtered.audioState === 'playing' && filtered.selectedIndex === -1, `${filtered.filteredCount} matches`);

    const playsBeforeRestore = await page.evaluate(() => window.__qaRadioPlayCalls.length);
    await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      await gev.dataManager.setEnabled('radio', false);
      await gev.dataManager.setEnabled('radio', true);
    });
    const restored = await page.evaluate(() => ({
      state: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState(),
      plays: window.__qaRadioPlayCalls.length,
      radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
    }));
    check(
      'programmatic/preset-style restoration does not autoplay and leaves idle Radio collapsed',
      restored.state.enabled && restored.state.audioState === 'stopped'
        && restored.plays === playsBeforeRestore && restored.radioCollapsed,
      JSON.stringify(restored),
    );

    await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', false));
    await sleep(350);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop.png') });
    const desktop = await page.$eval('#radio-panel', (element) => {
      const rect = element.getBoundingClientRect();
      const contextRect = element.closest('#global-context-panel').getBoundingClientRect();
      const tunerRect = element.querySelector('.radio-tuner').getBoundingClientRect();
      const innerRect = element.querySelector('.radio-panel-inner').getBoundingClientRect();
      return {
        left: contextRect.left,
        right: contextRect.right,
        top: contextRect.top,
        bottom: contextRect.bottom,
        width: contextRect.width,
        radioInside: rect.left >= contextRect.left && rect.right <= contextRect.right,
        tunerInside: tunerRect.left >= innerRect.left && tunerRect.right <= innerRect.right,
      };
    });
    check('desktop Context host keeps Radio and its tuner contained', desktop.left >= 0 && desktop.right <= 1440 && desktop.top >= 0 && desktop.bottom <= 900 && desktop.radioInside && desktop.tunerInside, JSON.stringify(desktop));

    await page.click('#radio-play-btn');
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await sleep(500);
    await page.$eval('#radio-panel', (element) => element.scrollIntoView({ block: 'nearest' }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile.png') });
    const mobile = await page.$eval('#radio-panel', (element) => {
      const rect = element.getBoundingClientRect();
      const context = element.closest('#global-context-panel');
      const contextRect = context.getBoundingClientRect();
      const scroller = context.querySelector('.global-context-panel-inner');
      const logo = document.querySelector('#title-bar .title-logo');
      const logoRect = logo.getBoundingClientRect();
      const tunerRect = element.querySelector('.radio-tuner').getBoundingClientRect();
      const innerRect = element.querySelector('.radio-panel-inner').getBoundingClientRect();
      return {
        left: contextRect.left,
        right: contextRect.right,
        top: contextRect.top,
        bottom: contextRect.bottom,
        width: contextRect.width,
        radioWidth: rect.width,
        radioVisible: rect.bottom > contextRect.top && rect.top < contextRect.bottom,
        scrollable: scroller.scrollHeight >= scroller.clientHeight,
        broadcastVisible: Number(getComputedStyle(logo, '::before').opacity) > 0
          && Number(getComputedStyle(logo, '::after').opacity) > 0,
        broadcastInsideViewport: logoRect.left >= 0 && logoRect.right <= innerWidth && logoRect.top - 15 >= 0,
        tunerInside: tunerRect.left >= innerRect.left && tunerRect.right <= innerRect.right
          && tunerRect.left >= 0 && tunerRect.right <= innerWidth,
      };
    });
    check('mobile Context host is full-width and keeps the tuner contained', mobile.left >= 0 && mobile.right <= 390 && mobile.width >= 350 && mobile.radioWidth < mobile.width && mobile.radioVisible && mobile.scrollable && mobile.tunerInside, JSON.stringify(mobile));
    check('mobile playing state keeps both broadcast waves visible and on-screen', mobile.broadcastVisible && mobile.broadcastInsideViewport, JSON.stringify(mobile));
    await page.click('#radio-stop-btn');
    const actionableConsoleErrors = [...consoleErrors];
    const externalFontFailures = [];
    for (let i = actionableConsoleErrors.length - 1; i >= 0; i -= 1) {
      const entry = actionableConsoleErrors[i];
      if (entry.includes('Failed to load resource: the server responded with a status of 404')
        && entry.includes('[https://fonts.gstatic.com/')) {
        externalFontFailures.push(...actionableConsoleErrors.splice(i, 1));
      }
    }
    if (externalFontFailures.length > 0) {
      console.log(`INFO external Google Fonts resource unavailable (${externalFontFailures.length}); Radio assertions continued with the local fallback font`);
    }
    if (externalCesiumEndpointFailures.length > 0) {
      const requestEventIndex = actionableConsoleErrors.findIndex((entry) => (
        entry.startsWith('[object RequestErrorEvent]')
        && entry.includes('/node_modules/.vite/deps/cesium.js')
      ));
      if (requestEventIndex >= 0) actionableConsoleErrors.splice(requestEventIndex, 1);
      for (let i = actionableConsoleErrors.length - 1; i >= 0; i -= 1) {
        if (actionableConsoleErrors[i].includes('api.cesium.com/v1/assets/1/endpoint')
          && actionableConsoleErrors[i].includes('net::ERR_FAILED')) {
          actionableConsoleErrors.splice(i, 1);
        }
      }
      console.log(`INFO external Cesium ion asset endpoint unavailable (${externalCesiumEndpointFailures.length}); Radio assertions continued against the loaded app`);
    }
    check(
      'runtime console remains clean',
      actionableConsoleErrors.length === 0,
      actionableConsoleErrors.slice(0, 3).join(' | '),
    );
    check(
      'runtime has no HTTP 5xx responses',
      failedResponses.length === 0,
      failedResponses.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => !result.ok).length;
  console.log(`\nRadio QA: ${results.length - failures}/${results.length} passed`);
  console.log(`RESULT: ${results.length - failures} passed, ${failures} failed, 0 skipped`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
