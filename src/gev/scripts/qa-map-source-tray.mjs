#!/usr/bin/env node
/** Focused browser proof for the responsive, accessible Map Source tray. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(repoRoot, 'qa-shots', 'map-source-tray');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
// The no-ion-token contract is a real shipped state that a normal keyed
// `dev-fresh.sh` run can never reach, so it went untested on every machine that
// has a token. `--keyless` (or QA_MAP_SOURCE_TRAY_KEYLESS=1) clears the
// controller's token in-page before the key-required assertions, so one server
// can prove both branches. It forces the keyless EXPECTATIONS as well: a seam
// that fails to take effect is a failure, not a quiet fall-through to the keyed
// branch.
const forceKeyless = process.argv.includes('--keyless')
  || process.env.QA_MAP_SOURCE_TRAY_KEYLESS === '1';
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();

if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}
fs.mkdirSync(shotsDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
});
const page = await browser.newPage();
const failures = [];
const consoleErrors = [];

page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource.*404/i.test(message.text())) {
    const source = message.location()?.url;
    consoleErrors.push(source ? `${message.text()} [${source}]` : message.text());
  }
});
page.on('pageerror', (error) => consoleErrors.push(error.message));

const check = (name, passed, detail = '') => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

const trayMetrics = () => page.evaluate(() => {
  const panel = document.getElementById('control-panel');
  const popover = document.getElementById('control-panel-popover');
  const row = document.getElementById('map-stack-chips');
  const popoverRect = popover.getBoundingClientRect();
  const chips = [...row.children].map((chip) => {
    const rect = chip.getBoundingClientRect();
    return {
      id: chip.dataset.stackId,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      pressed: chip.getAttribute('aria-pressed'),
      ariaDisabled: chip.getAttribute('aria-disabled'),
      ariaLabel: chip.getAttribute('aria-label'),
    };
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    pinned: panel.classList.contains('dock-pinned'),
    popover: {
      left: popoverRect.left,
      right: popoverRect.right,
      top: popoverRect.top,
      bottom: popoverRect.bottom,
      width: popoverRect.width,
    },
    columns: getComputedStyle(row).gridTemplateColumns,
    rows: new Set(chips.map((chip) => chip.top)).size,
    chips,
  };
});

try {
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/openai/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'Map Source tray QA' }),
      });
      return;
    }
    request.continue();
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 60_000 });
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );

  const presentation = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.map-stack-chip')].map((chip) => chip.dataset.stackId),
    retiredPanel: Boolean(document.getElementById('stack-panel')),
    toggleTag: document.getElementById('control-panel-toggle')?.tagName,
    controls: document.getElementById('control-panel-toggle')?.getAttribute('aria-controls'),
  }));
  check(
    'exact four-source presentation; the retired left Map Stack panel is gone',
    JSON.stringify(presentation.ids) === JSON.stringify([
      'photoreal', 'bing-aerial', 'bing-labels', 'osm',
    ]) && !presentation.retiredPanel,
    JSON.stringify(presentation),
  );
  check(
    'compact wing is a semantic disclosure',
    presentation.toggleTag === 'BUTTON' && presentation.controls === 'control-panel-popover',
    JSON.stringify(presentation),
  );

  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const keyboardOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'Enter opens the tray and hands focus to a Map Source tile',
    keyboardOpen.expanded === 'true' && keyboardOpen.activeStack === 'photoreal',
    JSON.stringify(keyboardOpen),
  );

  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const keyboardClose = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeId: document.activeElement?.id || null,
  }));
  check(
    'Escape closes the tray and restores disclosure focus',
    keyboardClose.expanded === 'false' && keyboardClose.activeId === 'control-panel-toggle',
    JSON.stringify(keyboardClose),
  );

  await page.keyboard.press('Space');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const spaceOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'Space opens the tray through the same keyboard path',
    spaceOpen.expanded === 'true' && spaceOpen.activeStack === 'photoreal',
    JSON.stringify(spaceOpen),
  );

  await page.keyboard.press('Escape');
  await page.keyboard.down('Enter');
  await new Promise((resolve) => setTimeout(resolve, 320));
  await page.keyboard.up('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const longHoldRecovery = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'long Enter hold cannot strand the disclosure keyboard path',
    longHoldRecovery.expanded === 'true' && longHoldRecovery.activeStack === 'photoreal',
    JSON.stringify(longHoldRecovery),
  );

  if (forceKeyless) {
    await page.evaluate(() => {
      const styleManager = window.__godsEyeView.styleManager;
      window.__qaIonTokenBackup = styleManager.mapStackController.cesiumToken;
      styleManager.mapStackController.cesiumToken = '';
      styleManager._initMapStackControl();
    });
  }
  await page.focus('[data-stack-id="bing-aerial"]');
  const ionAvailable = await page.$eval(
    '[data-stack-id="bing-aerial"]',
    (chip) => chip.getAttribute('aria-disabled') !== 'true',
  );
  await page.click('[data-stack-id="bing-aerial"]');
  if (ionAvailable) {
    // Cesium creates the imagery provider asynchronously. Wait for controller
    // truth instead of assuming a keyed switch can settle in one animation.
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.mapStackController.getActiveId() === 'bing-aerial'
        || Boolean(window.__godsEyeView.styleManager.mapStackController.getState()?.lastError),
      { timeout: 20_000 },
    ).catch(() => {});
  }
  const ionSource = await page.evaluate(() => {
    const chip = document.querySelector('[data-stack-id="bing-aerial"]');
    return {
      focused: document.activeElement === chip,
      ariaDisabled: chip.getAttribute('aria-disabled'),
      ariaLabel: chip.getAttribute('aria-label'),
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((candidate) => candidate.getAttribute('aria-pressed') === 'true')
        .map((candidate) => candidate.dataset.stackId),
    };
  });
  if (forceKeyless || ionSource.ariaDisabled === 'true') {
    check(
      'key-required sources stay focusable, explained, and inert when no ion token is configured',
      ionSource.ariaDisabled === 'true'
        && ionSource.focused
        && /token required/i.test(ionSource.ariaLabel)
        && JSON.stringify(ionSource.active) === JSON.stringify(['photoreal']),
      JSON.stringify(ionSource),
    );
  } else {
    check(
      'key-required sources switch normally when the ion token is configured',
      ionSource.focused
        && ionSource.ariaDisabled === 'false'
        && JSON.stringify(ionSource.active) === JSON.stringify(['bing-aerial']),
      JSON.stringify(ionSource),
    );
  }
  if (forceKeyless) {
    // Hand the real token back so every later assertion runs against the same
    // configuration in both invocations.
    await page.evaluate(() => {
      const styleManager = window.__godsEyeView.styleManager;
      styleManager.mapStackController.cesiumToken = window.__qaIonTokenBackup || '';
      delete window.__qaIonTokenBackup;
      styleManager._initMapStackControl();
    });
  }

  const switching = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const controller = styleManager.mapStackController;
    const originalSetStack = controller.setStack.bind(controller);
    const before = controller.getActiveId();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controller.setStack = async (stackId) => {
      await gate;
      return originalSetStack(stackId);
    };
    const switchPromise = styleManager._setMapStack('osm', { syncShare: false });
    const during = {
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    release();
    await switchPromise;
    const after = {
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    controller.setStack = originalSetStack;
    await styleManager._setMapStack(before, { syncShare: false });
    return { before, during, after };
  });
  check(
    'switching feedback is truthful and active state moves only after commit',
    switching.during.status === '...'
      && JSON.stringify(switching.during.active) === JSON.stringify([switching.before])
      && JSON.stringify(switching.after.active) === JSON.stringify(['osm']),
    JSON.stringify(switching),
  );

  const acquiringLifecycle = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const status = document.getElementById('global-loading-status');
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const pending = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'followed',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    const followed = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'source-unavailable',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const staleTerminal = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'cancelled',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    const cancelled = snapshot();
    return { pending, followed, staleTerminal, cancelled };
  });
  check(
    'ACQUIRING DOM notice persists, ignores stale terminals, and clears on ownership completion',
    acquiringLifecycle.pending.hidden === false
      && acquiringLifecycle.pending.state === 'acquiring'
      && acquiringLifecycle.pending.label === 'ACQUIRING'
      && acquiringLifecycle.pending.detail === 'SHARED FLIGHT'
      && acquiringLifecycle.followed.hidden === true
      && acquiringLifecycle.staleTerminal.hidden === false
      && acquiringLifecycle.staleTerminal.state === 'acquiring'
      && acquiringLifecycle.staleTerminal.detail === 'SHARED MILITARY FLIGHT'
      && acquiringLifecycle.cancelled.hidden === true,
    JSON.stringify(acquiringLifecycle),
  );

  const acquiringFailureArbitration = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = styleManager._dataManager;
    const status = document.getElementById('global-loading-status');
    const originalGetAll = dataManager.getAll;
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    const waitForQueuedNotice = async (label, timeoutMs = 1000) => {
      const deadline = performance.now() + timeoutMs;
      while (styleManager._globalStatusNotice?.label !== label
          && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return styleManager._globalStatusNotice?.label === label;
    };
    const baseNow = performance.now();
    try {
      styleManager._loadingFeedbackState = {
        phase: 'idle', visible: false, startedAt: 0, showAt: 0, hideAt: 0,
        activeIds: [], batchOutcome: null, terminal: null, operation: null,
      };
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'pending',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      dataManager.getAll = () => [{
        id: 'qa-unrelated-layer',
        name: 'QA unrelated layer',
        lifecycleState: 'enabling',
        enabled: false,
        stats: {},
      }];
      styleManager._updateGlobalLoadingFeedback(baseNow);
      styleManager._updateGlobalLoadingFeedback(baseNow + 200);
      dataManager.getAll = () => [];
      styleManager._loadingFeedbackEvent = {
        type: 'visibility-failed',
        layerId: 'qa-unrelated-layer',
        error: new Error('QA offline'),
      };
      styleManager._updateGlobalLoadingFeedback(baseNow + 300);
      const failureStart = snapshot();
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'source-unavailable',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      const queuedNoticeReady = await waitForQueuedNotice(
        'Shared flight could not be restored — feed unavailable',
      );
      const shareFailureQueued = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5299);
      const failureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5300);
      const shareFailureStart = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10299);
      const shareFailureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10300);
      const settled = snapshot();
      return {
        failureStart,
        queuedNoticeReady,
        shareFailureQueued,
        failureEnd,
        shareFailureStart,
        shareFailureEnd,
        settled,
      };
    } finally {
      dataManager.getAll = originalGetAll;
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'cancelled',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
    }
  });
  check(
    'manager failure then queued share failure each receives its full visible dwell',
    acquiringFailureArbitration.failureStart.hidden === false
      && acquiringFailureArbitration.failureStart.state === 'error'
      && acquiringFailureArbitration.failureStart.label === 'LOAD FAILED'
      && acquiringFailureArbitration.queuedNoticeReady === true
      && acquiringFailureArbitration.shareFailureQueued.state === 'error'
      && acquiringFailureArbitration.shareFailureQueued.label === 'LOAD FAILED'
      && acquiringFailureArbitration.failureEnd.state === 'error'
      && acquiringFailureArbitration.failureEnd.label === 'LOAD FAILED'
      && acquiringFailureArbitration.shareFailureStart.state === 'error'
      && acquiringFailureArbitration.shareFailureStart.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.shareFailureEnd.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.settled.hidden === true,
    JSON.stringify(acquiringFailureArbitration),
  );

  // Unpinned mouse-away dismissal AFTER a tile click. Chromium focuses a
  // <button> on mouse press, so a close-guard reading plain
  // `document.activeElement` left the tray permanently open once Map Source
  // moved into it — switch a basemap and the popover never went away again
  // (field report). The pin samples the exact mechanism: focus IS parked
  // inside the panel and is NOT `:focus-visible`, and the tray closes anyway.
  const setControlPanelPinned = (wanted) => page.evaluate((want) => {
    const panel = document.getElementById('control-panel');
    if (panel.classList.contains('dock-pinned') !== want) {
      document.querySelector('.dock-pin-btn[data-pin-target="control-panel"]').click();
    }
    return panel.classList.contains('dock-pinned');
  }, wanted);
  const readTrayState = () => page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    const active = document.activeElement;
    let focusVisible = null;
    try { focusVisible = active?.matches?.(':focus-visible') ?? null; } catch { focusVisible = null; }
    return {
      collapsed: panel.classList.contains('collapsed'),
      expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
      focusInside: panel.contains(active),
      focusVisible,
    };
  });
  const clickTileThenLeave = async (stackId) => {
    await page.evaluate(() => window.__godsEyeView.styleManager
      .setPanelCollapsed('control-panel', false, { explicit: true }));
    await new Promise((resolve) => setTimeout(resolve, 240));
    await page.click(`[data-stack-id="${stackId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterClick = await readTrayState();
    await page.mouse.move(20, 20); // leave the dock entirely → pointerleave
    // Past the 420 ms unpinned close delay with room for a slow frame.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { afterClick, afterLeave: await readTrayState() };
  };

  // The OTHER half of the same rule, asserted positively: a KEYBOARD user who
  // tabbed to a tile and pressed Enter must keep the tray, because closing it
  // out from under them would strand the caret in a hidden surface. Same
  // mouse-away that dismisses after a click, opposite outcome — so a fix that
  // simply deleted the focus guard would fail here.
  await setControlPanelPinned(false);
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', true, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter'); // opens and hands focus to the active tile
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.keyboard.press('Tab'); // tab ONTO a tile, keyboard modality
  await page.keyboard.press('Enter'); // activate it from the keyboard
  await new Promise((resolve) => setTimeout(resolve, 200));
  const keyboardAfterActivate = await page.evaluate(() => ({
    focusedStack: document.activeElement?.dataset?.stackId || null,
    isChip: !!document.activeElement?.classList?.contains('map-stack-chip'),
  }));
  // Enter the tray with the pointer and leave again, so a real pointerleave
  // schedules the close this pin expects to be declined.
  const chipPoint = await page.$eval('#map-stack-chips .map-stack-chip', (chip) => {
    const rect = chip.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(chipPoint.x, chipPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await page.mouse.move(20, 20);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const keyboardHold = await readTrayState();
  check(
    'keyboard activation of a tile HOLDS the tray open through the same mouse-away',
    keyboardAfterActivate.isChip === true
      && keyboardHold.collapsed === false
      && keyboardHold.expanded === 'true'
      && keyboardHold.focusInside === true
      && keyboardHold.focusVisible === true,
    JSON.stringify({ keyboardAfterActivate, keyboardHold }),
  );

  await setControlPanelPinned(false);
  const dismissAfterTileClick = await clickTileThenLeave('osm');
  const pinnedForHold = await setControlPanelPinned(true);
  const pinnedHold = await clickTileThenLeave('photoreal');
  await setControlPanelPinned(false);
  await page.evaluate(() => window.__godsEyeView.styleManager
    ._setMapStack('photoreal', { syncShare: false }));
  // Hand the tray back OPEN and unpinned — the responsive block below starts by
  // clicking the pin control, which is only hittable while the tray is showing.
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', false, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 240));
  check(
    'a tile click does not exempt the unpinned tray from mouse-away auto-dismiss',
    dismissAfterTileClick.afterClick.collapsed === false
      && dismissAfterTileClick.afterClick.focusInside === true
      && dismissAfterTileClick.afterClick.focusVisible === false
      && dismissAfterTileClick.afterLeave.collapsed === true
      && dismissAfterTileClick.afterLeave.expanded === 'false'
      && pinnedForHold === true
      && pinnedHold.afterLeave.collapsed === false,
    JSON.stringify({ dismissAfterTileClick, pinnedForHold, pinnedHold }),
  );

  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  const desktop = await trayMetrics();
  check(
    'desktop tray is one row and fully inside the viewport',
    desktop.rows === 1
      && desktop.popover.left >= 0
      && desktop.popover.right <= desktop.viewport.width,
    JSON.stringify(desktop),
  );

  await page.setViewport({ width: 620, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at620 = await trayMetrics();
  check(
    '620 px tray uses two rows without clipping',
    at620.expanded === 'true'
      && at620.pinned
      && at620.rows === 2
      && at620.popover.left >= 0
      && at620.popover.right <= at620.viewport.width,
    JSON.stringify(at620),
  );

  await page.setViewport({ width: 480, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at480 = await trayMetrics();
  const allRectsInside = at480.chips.every((chip) => (
    chip.left >= 0 && chip.right <= at480.viewport.width
      && chip.top >= 0 && chip.bottom <= at480.viewport.height
  ));
  check(
    '480 px live resize keeps the open tray and every tile in bounds',
    at480.expanded === 'true'
      && at480.pinned
      && at480.rows === 2
      && at480.popover.left >= 0
      && at480.popover.right <= at480.viewport.width
      && allRectsInside,
    JSON.stringify(at480),
  );
  await page.screenshot({ path: path.join(shotsDir, '480-open.png') });

  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  await page.click('#control-panel-toggle');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const toggleRect = await page.$eval('#control-panel-toggle', (toggle) => {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.touchscreen.tap(toggleRect.x, toggleRect.y);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const touchOpen = await page.$eval('#control-panel-toggle', (toggle) => toggle.getAttribute('aria-expanded'));
  check('coarse-pointer tap opens the compact wing', touchOpen === 'true', `aria-expanded=${touchOpen}`);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // Retired and unknown stack ids take the SAME path. `bing-road` was the fifth
  // source behind the retired left Map Stack panel; deleting it from
  // `MAP_STACKS` (no build carrying it ever shipped publicly, so no link is
  // owed anything) means an old `map=bing-road` link is now simply an
  // unrecognized id, and `setStack()`'s `getStack(id) || getStack('photoreal')`
  // fallback lands it on Google 3D with that tile lit — never on a hidden fifth
  // source whose status reads ROAD while no tile is pressed.
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  for (const legacyId of ['bing-road', 'garbage']) {
    await page.goto(`${appUrl}#v=2&lat=30.27&lon=-97.74&map=${legacyId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 60_000 });
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.mapStackController.getState()?.status !== 'switching',
      { timeout: 20_000 },
    ).catch(() => {});
    const restored = await page.evaluate(() => ({
      activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
      lastError: window.__godsEyeView.styleManager.mapStackController.getState()?.lastError || null,
      status: document.getElementById('map-stack-status').textContent.trim(),
      pressed: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    }));
    check(
      `a map=${legacyId} link restores to photoreal with the photoreal tile lit`,
      restored.activeId === 'photoreal'
        && restored.lastError === null
        && JSON.stringify(restored.pressed) === JSON.stringify(['photoreal']),
      JSON.stringify(restored),
    );
    await page.screenshot({ path: path.join(shotsDir, `legacy-${legacyId}.png`) });
  }

  check('no new page or console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nMap Source tray QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nMap Source tray QA passed.');
}
