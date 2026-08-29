import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ShareLinkManager, decodeShareCreatedAtMs } from './sharelink.js';
import { createDefaultLayerState } from './data/layerState.js';

const uiSource = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

function sourceBlock(start, end) {
  const startIndex = uiSource.indexOf(start);
  const endIndex = uiSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source block start: ${start}`);
  assert.ok(endIndex > startIndex, `missing source block end: ${end}`);
  return uiSource.slice(startIndex, endIndex);
}

function assertClaimsBefore(block, mutation, label) {
  const claimIndex = block.indexOf("claimRestoreLane?.('visual')");
  const mutationIndex = block.indexOf(mutation);
  assert.ok(claimIndex >= 0, `${label} must claim the visual restore lane`);
  assert.ok(mutationIndex >= 0, `${label} mutation marker is missing`);
  assert.ok(claimIndex < mutationIndex, `${label} must claim before mutation`);
}

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

function installClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

test('share links without cr default the celestial ring off', () => {
  const manager = makeManager('#lat=10&lon=20&style=normal');
  assert.equal(manager.parseInitialHash().celestialRing, false);
});

test('share links parse explicit celestial on and off states', () => {
  assert.equal(makeManager('#lat=10&lon=20&cr=1').parseInitialHash().celestialRing, true);
  assert.equal(makeManager('#lat=10&lon=20&cr=0').parseInitialHash().celestialRing, false);
});

test('unknown-only v2 layer tokens are invalid, while historical l fields stay inert', () => {
  const invalid = makeManager('#v=2&lat=10&lon=20&l=z').parseInitialHash();
  assert.equal(invalid.layerState, null);
  assert.equal(invalid.layerStateInvalid, true);
  for (const hash of ['#lat=10&lon=20&l=z', '#v=1&lat=10&lon=20&l=z']) {
    const legacy = makeManager(hash).parseInitialHash();
    assert.equal(legacy.layerState, null);
    assert.equal(legacy.layerStateInvalid, false);
  }
});

test('share-link serialization emits the current celestial state', () => {
  const manager = makeManager();
  manager.onToggleChange(false, false, { celestialRingEnabled: false });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('cr'), '0');

  manager.onToggleChange(false, false, { celestialRingEnabled: true });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('cr'), '1');
});

test('generated links are v2 and include deterministic layers, options, style params, and panels', () => {
  const manager = makeManager();
  const layers = createDefaultLayerState();
  layers.enabledLayerIds = ['cctv', 'radio'];
  layers.options.cctv = { coverageMode: 'viewshed', showProjection: false, autoHop: true };
  layers.options.radio = { filter: 'news', volume: 0.45 };
  manager.setLayerStateProvider(() => layers);
  manager.setPanelStateProvider(() => ({ specs: [
    { id: 'control-panel', collapsed: false, pinned: true },
    { id: 'param-slider-panel', collapsed: true },
  ] }));
  manager.setStyleParamStateProvider(() => ({
    sensitivity: 0.82, bloom: 0.37, mode: 1, pixelation: 2.6, palette: 1,
  }));
  manager.onStyleChange('thermal');
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  const params = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(params.get('v'), '2');
  assert.equal(params.get('l'), 'c.r');
  assert.equal(params.get('sp'), 's.82_b.37_m.100_p.260_a.100');
  assert.equal(params.get('ui'), 'c.c.0_c.p.1_m.c.1');
});

test('visual parameters, explicit empty layers, and panel state are v2-only', () => {
  const parsed = makeManager(
    '#v=2&lat=10&lon=20&style=flir&l=&sp=s.82_b.37_p.260&ui=c.c.0_c.p.1_d.c.1_d.p.1',
  ).parseInitialHash();
  assert.deepEqual(parsed.layerState.enabledLayerIds, []);
  assert.deepEqual(parsed.styleParams, { sensitivity: 0.82, bloom: 0.37, pixelation: 2.6 });
  assert.deepEqual(parsed.panelState, { specs: [
    { id: 'control-panel', collapsed: false, pinned: true },
    { id: 'data-panel', collapsed: true, pinned: null },
  ] });
  const legacy = makeManager('#v=1&lat=10&lon=20&style=flir&l=&sp=s.82&ui=c.c.0')
    .parseInitialHash();
  assert.equal(legacy.layerState, null);
  assert.equal(legacy.styleParams, null);
  assert.equal(legacy.panelState, null);
});

test('camera-only, partial, and malformed panel shares remain valid incoming state', () => {
  const cameraOnly = makeManager('#lat=10&lon=20').parseInitialHash();
  assert.ok(cameraOnly);
  assert.equal(cameraOnly.panelState, null);

  const partial = makeManager('#v=2&lat=10&lon=20&ui=d.c.0').parseInitialHash();
  assert.deepEqual(partial.panelState, { specs: [
    { id: 'data-panel', collapsed: false, pinned: null },
  ] });

  for (const hash of [
    '#v=2&lat=10&lon=20&ui=',
    '#v=2&lat=10&lon=20&ui=unknown.c.1',
    '#v=2&lat=10&lon=20&ui=d.c.maybe',
  ]) {
    const malformed = makeManager(hash).parseInitialHash();
    assert.ok(malformed);
    assert.equal(malformed.panelState, null);
  }
});

// Both `bing-road` and the `k` panel token belonged to the retired left Map
// Stack panel. Nothing is owed to a link that carried them — no build with
// either one ever shipped publicly — so the parser no longer knows them, and
// each takes the ordinary unknown path: an unrecognized panel token is skipped,
// and an unrecognized stack id lands on the controller's photoreal fallback
// (pinned live in `scripts/qa-map-source-tray.mjs`). The camera half of such a
// link must still restore.
test('a retired-vocabulary link degrades to the unknown paths instead of failing', () => {
  const parsed = makeManager('#v=2&lat=10&lon=20&map=bing-road&ui=k.c.0').parseInitialHash();
  assert.equal(parsed.lat, 10);
  assert.equal(parsed.lon, 20);
  assert.equal(parsed.panelState, null);
});

test('non-finite camera coordinates fail closed without reserving restoration', () => {
  for (const hash of [
    '#lat=Infinity&lon=20',
    '#lat=10&lon=-Infinity',
    '#lat=1e309&lon=20',
    '#v=2&lat=%2BInfinity&lon=20',
  ]) {
    const manager = makeManager(hash);
    assert.equal(manager.parseInitialHash(), null, hash);
    assert.equal(manager._initialRestorePending, false, hash);
  }

  assert.ok(makeManager('#lat=10&lon=20').parseInitialHash());
  assert.ok(makeManager('#v=2&lat=-10.5&lon=20.25').parseInitialHash());
});

test('incoming state suppresses premature hash replacement until restoration', () => {
  const manager = makeManager('#v=2&lat=10&lon=20&l=e&style=nvg');
  manager.parseInitialHash();
  manager._updateHash();
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=e&style=nvg');
});

test('a shared view reserves its own camera without cancelling its saved Follow', () => {
  assert.match(
    uiSource,
    /_beginDeferredNavigation\(\s*'shared view',\s*\{ cancelPendingSelection: false \},\s*\)/,
  );
  const deferred = sourceBlock(
    "  _beginDeferredNavigation(noun = 'location', { cancelPendingSelection = true } = {}) {",
    '  /** Final authority check and release immediately before a delayed flight. */',
  );
  // The shared view's own `cancelPendingSelection` must reach the stamp; other
  // stamp options may ride alongside it.
  assert.match(deferred, /_stampNavigation\(\{ cancelPendingSelection[^)]*\}\)/);
});

test('copy timestamp parsing is strict and rejects malformed or future values', () => {
  const nowMs = 2_000_000;
  assert.equal(decodeShareCreatedAtMs(new URLSearchParams('at=1999'), { nowMs }), 1_999_000);
  for (const raw of ['', '0', '-1', '1.5', 'abc', '001', '9007199254740992']) {
    assert.equal(
      decodeShareCreatedAtMs(new URLSearchParams(`at=${encodeURIComponent(raw)}`), { nowMs }),
      null,
      raw,
    );
  }
  assert.equal(decodeShareCreatedAtMs(new URLSearchParams('at=2001'), { nowMs }), null);
});

test('copy adds a fresh ephemeral timestamp without aging the live URL', async () => {
  const copied = [];
  installClipboard(async (url) => { copied.push(url); });
  const manager = makeManager();
  manager._updateHash();
  const liveHash = window.location.hash;

  assert.equal(await manager.copyLink({ nowMs: 2_000_000 }), true);
  assert.equal(await manager.copyLink({ nowMs: 2_002_000 }), true);
  assert.equal(new URL(copied[0]).hash.includes('at=2000'), true);
  assert.equal(new URL(copied[1]).hash.includes('at=2002'), true);
  assert.equal(window.location.hash, liveHash);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('at'), false);
});

test('copy snapshots current state while incoming hash writes are still suppressed', async () => {
  let copied = null;
  installClipboard(async (url) => { copied = url; });
  const manager = makeManager('#v=2&lat=10&lon=20&l=e&at=100');
  manager.parseInitialHash();
  assert.equal(manager._initialRestorePending, true);
  assert.equal(await manager.copyLink({ nowMs: 3_000_000 }), true);
  const params = new URL(copied).hash.slice(1);
  assert.equal(new URLSearchParams(params).get('at'), '3000');
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=e&at=100');
});

test('clipboard rejection leaves both live URL and restore suppression untouched', async () => {
  installClipboard(async () => { throw new Error('denied'); });
  const manager = makeManager('#v=2&lat=10&lon=20&l=s');
  manager.parseInitialHash();
  assert.equal(await manager.copyLink({ nowMs: 4_000_000 }), false);
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=s');
  assert.equal(manager._initialRestorePending, true);
});

test('legacy Panoptic and Sparse hashes migrate to canonical profiles', () => {
  const panoptic = makeManager('#lat=10&lon=20&dm=PANOPTIC&dd=0').parseInitialHash();
  assert.equal(panoptic.detectionMode, 'DENSE');
  assert.equal(panoptic.detectionDensity, 75);
  const sparse = makeManager('#lat=10&lon=20&dm=SPARSE&dd=100').parseInitialHash();
  assert.equal(sparse.detectionMode, 'SPARSE');
  assert.equal(sparse.detectionDensity, 25);
});

test('allocation strategy defaults to Elastic and round-trips Weighted', () => {
  assert.equal(makeManager('#lat=10&lon=20').parseInitialHash().detectionAllocation, 'ELASTIC');
  assert.equal(makeManager('#lat=10&lon=20&da=weighted').parseInitialHash().detectionAllocation, 'WEIGHTED');

  const manager = makeManager();
  manager.onToggleChange(false, false, { detectionAllocation: 'WEIGHTED' });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('da'), 'weighted');
});

test('keyhole fade controls default and round-trip as normalized percentages', () => {
  const defaults = makeManager('#lat=10&lon=20').parseInitialHash();
  assert.equal(defaults.detectionFadePct, 16);
  assert.equal(defaults.detectionOutsideOpacityPct, 5);

  const restored = makeManager('#lat=10&lon=20&kf=28&ko=35').parseInitialHash();
  assert.equal(restored.detectionFadePct, 28);
  assert.equal(restored.detectionOutsideOpacityPct, 35);

  const manager = makeManager();
  manager.onToggleChange(false, false, {
    detectionFadePct: 22,
    detectionOutsideOpacityPct: 30,
  });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  const params = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(params.get('kf'), '22');
  assert.equal(params.get('ko'), '30');
});

// ── `sce` is a BAND, not a free number (second review) ───────────────────────
//
// The terminus is documented and supported as 94..100. Parsing clamped to
// 0..100, so `sce=0` produced an unsupported sub-94 terminus — a hole in the
// mask, not a scope — and the next hash write serialized it straight back out.

test('sce is clamped into the supported 94..100 band on the way in', () => {
  assert.equal(makeManager('#lat=10&lon=20&sce=97').parseInitialHash().scopeTerminusPct, 97);
  assert.equal(makeManager('#lat=10&lon=20&sce=94').parseInitialHash().scopeTerminusPct, 94);
  assert.equal(makeManager('#lat=10&lon=20&sce=100').parseInitialHash().scopeTerminusPct, 100);
  assert.equal(makeManager('#lat=10&lon=20&sce=0').parseInitialHash().scopeTerminusPct, 94,
    'sce=0 must not create a sub-94 terminus');
  assert.equal(makeManager('#lat=10&lon=20&sce=93').parseInitialHash().scopeTerminusPct, 94);
  assert.equal(makeManager('#lat=10&lon=20&sce=-40').parseInitialHash().scopeTerminusPct, 94);
  assert.equal(makeManager('#lat=10&lon=20&sce=500').parseInitialHash().scopeTerminusPct, 100);
  assert.equal(makeManager('#lat=10&lon=20&sce=96.6').parseInitialHash().scopeTerminusPct, 97,
    'fractional percents round into the band');
});

test('an absent or non-numeric sce stays adaptive, never a pinned value', () => {
  assert.equal(makeManager('#lat=10&lon=20').parseInitialHash().scopeTerminusPct, null);
  assert.equal(makeManager('#lat=10&lon=20&sce=abc').parseInitialHash().scopeTerminusPct, null,
    'junk is not a pin — absent semantics win');
  assert.equal(makeManager('#lat=10&lon=20&sce=').parseInitialHash().scopeTerminusPct, null);
});

test('serialization writes only in-band sce values, and omits an adaptive one', () => {
  const manager = makeManager();
  manager.onToggleChange(false, false, { scopeTerminusPct: 0 });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('sce'), '94',
    'an out-of-band value must be floored on write, not round-tripped');

  manager.onToggleChange(false, false, { scopeTerminusPct: 500 });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('sce'), '100');

  manager.onToggleChange(false, false, { scopeTerminusPct: null });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('sce'), false,
    'adaptive stays ABSENT so a shared link never freezes the ramp');
});

test('share-link restore forces a final stationary render for Google 3D Tiles', () => {
  const calls = { flyTo: null, setView: null, renders: 0 };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
      flyTo(options) { calls.flyTo = options; },
      setView(options) { calls.setView = options; },
    },
    scene: { requestRender() { calls.renders += 1; } },
  };
  const manager = new ShareLinkManager(viewer);
  manager.applyState({
    lat: 40.7669,
    lon: -73.9909,
    alt: 396,
    heading: 206,
    pitch: -22,
    roll: 0,
  });

  assert.ok(calls.flyTo, 'restore must start a camera flight');
  assert.equal(typeof calls.flyTo.complete, 'function');
  calls.flyTo.complete();
  assert.deepEqual(calls.setView, {
    destination: calls.flyTo.destination,
    orientation: calls.flyTo.orientation,
  });
  assert.equal(calls.renders, 1);
});

test('newer navigation suppresses delayed share camera while non-camera state still restores', async () => {
  let flights = 0;
  let restored = null;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo() { flights += 1; },
    },
  };
  const manager = new ShareLinkManager(viewer, {
    onRestore: (state) => { restored = state; },
    isNavigationCurrent: () => false,
  });
  const applied = await manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
    style: 'thermal', panelState: { specs: [] },
  }, { navigationToken: 4 });
  assert.equal(applied.succeeded, true);
  assert.equal(flights, 0);
  assert.equal(restored.style, 'thermal');
});

test('newer visual, map, and individual panel actions suppress only their owned restore lanes', async () => {
  let restored = null;
  const manager = makeManager(
    '#v=2&lat=40&lon=-74&style=flir&map=osm&ui=c.c.0_d.c.0',
  );
  manager._onRestore = (state) => { restored = state; };
  manager._isNavigationCurrent = () => false;
  const state = manager.parseInitialHash();

  manager.claimRestoreLane('visual');
  manager.claimRestoreLane('map');
  manager.claimRestoreLane('panel', 'control-panel');
  const result = await manager.applyState(state, { navigationToken: 1 });

  assert.equal(restored.style, undefined);
  assert.equal(restored.mapStack, undefined);
  assert.deepEqual(restored.panelState, {
    specs: [{ id: 'data-panel', collapsed: false, pinned: null }],
  });
  assert.equal(result.visual, 'superseded');
  assert.equal(result.map, 'superseded');
  assert.equal(result.panels, 'applied');
  assert.equal(manager._initialRestorePending, true);
  manager.completeInitialRestore();
  assert.equal(manager._initialRestorePending, false);
});

test('every explicit visual UI gesture claims restore authority before it mutates state', () => {
  const initUi = sourceBlock('  _initUI() {', '  _initMapStackControl() {');
  const gestureRoutes = [
    ["if (e.key.toLowerCase() === 'h')", "if (e.key.toLowerCase() === 'o')", 'this.hud.toggle()', 'HUD hotkey'],
    ["if (e.key.toLowerCase() === 'd')", "if (e.key.toLowerCase() === 'c')", 'cycleDetectionMode()', 'detection hotkey'],
    ['// Bloom toggle', '// Bloom intensity slider', 'this._setBloomEnabled(', 'bloom button'],
    ['// Bloom intensity slider', '// Sharpen toggle', 'this._setBloomIntensity(', 'bloom slider'],
    ['// Sharpen toggle', '// Scope mask', 'this._setSharpenEnabled(', 'sharpen button'],
    ["this._scopeBtn?.addEventListener('click'", "this._scopeFeatherSlider?.addEventListener('input'", 'setScopeMaskEnabled(', 'scope button'],
    ["this._scopeFeatherSlider?.addEventListener('input'", 'if (this._sharpenSlider)', 'setScopeMaskFeather(', 'scope feather slider'],
    ["this._sharpenSlider.addEventListener('input'", 'if (this._hudLayoutSelect)', 'this._applySharpenIntensity(', 'sharpen slider'],
    ["this._hudLayoutSelect.addEventListener('change'", 'if (this._cleanViewBtn)', 'this._setHudVariant(', 'HUD layout select'],
    ["this._detectionDensitySlider.addEventListener('input'", 'for (const button of this._detectionAllocationBtns)', 'this._applyDetectionDensityFromUi()', 'detection density slider'],
    ["button.addEventListener('click'", 'for (const slider of [this._detectionFadeSlider', 'this._setDetectionAllocation(', 'detection allocation button'],
    ["slider?.addEventListener('input'", 'if (this._celestialBtn)', 'this._applyDetectionFadeFromUi()', 'detection fade controls'],
  ];
  for (const [start, end, mutation, label] of gestureRoutes) {
    const startIndex = initUi.indexOf(start);
    const endIndex = initUi.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `${label} route is missing`);
    assertClaimsBefore(initUi.slice(startIndex, endIndex), mutation, label);
  }

  const hudToggle = sourceBlock('  _initHUDToggle() {', '  _initCockpitDisplayPortal() {');
  assertClaimsBefore(
    hudToggle.slice(
      hudToggle.indexOf("this._hudBtn.addEventListener('click'"),
      hudToggle.indexOf('if (this._hudLayoutSelect)'),
    ),
    'this.hud.toggle()',
    'HUD button',
  );
  assertClaimsBefore(
    hudToggle.slice(
      hudToggle.indexOf("this._detectionBtn.addEventListener('click'"),
      hudToggle.indexOf('this._cockpitDisplayToggleBtn'),
    ),
    'cycleDetectionMode()',
    'detection button',
  );
});

// Contacts OWNS detection while it is active (forced Dense @ 75%). That makes
// an explicit Context transition a visual-lane gesture exactly like the HUD or
// detection controls: without a claim, the share restore that lands 1.5 s into
// startup re-applies the link's `dm`/`dd` straight over the forced preset and
// Contacts silently loses its own overlay. The sweep above enumerates routes
// explicitly, so a missing Context route was simply invisible to it.
test('explicit Context transitions claim the visual restore lane before transitioning', () => {
  // The named helper IS the claim; its body is pinned to the real lane call
  // immediately below, so routes may use either spelling.
  const assertContextClaimsBefore = (block, mutation, label) => {
    const claimIndex = Math.min(
      ...['_claimContextVisualAuthority()', "claimRestoreLane?.('visual')"]
        .map((marker) => block.indexOf(marker))
        .filter((index) => index >= 0),
    );
    const mutationIndex = block.indexOf(mutation);
    assert.ok(Number.isFinite(claimIndex), `${label} must claim the visual restore lane`);
    assert.ok(mutationIndex >= 0, `${label} mutation marker is missing`);
    assert.ok(claimIndex < mutationIndex, `${label} must claim before mutation`);
  };

  const helper = sourceBlock(
    '  _claimContextVisualAuthority() {',
    '  async _selectContextMode(mode, {',
  );
  assert.ok(
    helper.includes("claimRestoreLane?.('visual')"),
    'the Context authority helper must claim the visual lane',
  );

  const contextPanel = sourceBlock('  _initGlobalContextPanel() {', '  async _runUserFacingContextAction(');
  for (const [start, end, label] of [
    ["this._globalContextFlightsBtn?.addEventListener('click'", "this._globalContextMissionsBtn?.addEventListener('click'", 'Contacts tab'],
    ["this._globalContextMissionsBtn?.addEventListener('click'", 'CONTEXT_PANEL_END', 'Space Missions tab'],
  ]) {
    const startIndex = contextPanel.indexOf(start);
    const endIndex = end === 'CONTEXT_PANEL_END'
      ? contextPanel.length
      : contextPanel.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `${label} route is missing`);
    assertContextClaimsBefore(contextPanel.slice(startIndex, endIndex), 'this._selectContextMode(', label);
  }

  // The voice/tool facade validates the mode first, then transitions.
  const facade = sourceBlock('  async setContextMode(mode, {', '  getCockpitState() {');
  assertContextClaimsBefore(facade, 'this._selectContextMode(', 'setContextMode facade');
  // Authority is taken per validated branch, never ahead of validation. The
  // OFF branch is validated by its own guard; the named-mode branch must claim
  // only AFTER the unknown-mode rejection, so a rejected request takes nothing.
  const offGuardIndex = facade.indexOf("if (!mode || mode === 'off')");
  const rejectIndex = facade.indexOf('Unknown context mode');
  assert.ok(offGuardIndex >= 0, 'setContextMode must keep its OFF guard');
  assert.ok(rejectIndex > offGuardIndex, 'setContextMode must still reject unknown modes');

  const offBranchClaim = facade.indexOf('_claimContextVisualAuthority()', offGuardIndex);
  assert.ok(
    offBranchClaim > offGuardIndex && offBranchClaim < rejectIndex,
    'the OFF transition must claim inside its own validated branch',
  );
  const namedBranchClaim = facade.indexOf('_claimContextVisualAuthority()', rejectIndex);
  assert.ok(
    namedBranchClaim > rejectIndex,
    'a named Context mode must claim only after the unknown-mode rejection',
  );
  assert.ok(
    namedBranchClaim < facade.indexOf('this._selectContextMode(', rejectIndex),
    'the named-mode claim must precede its transition',
  );
});

// Claiming the lane must NOT masquerade as the operator hand-editing
// detection: `_detectionUserOverridden` is what suppresses the military-style
// auto-enable for the rest of the session. Contacts entry is not that.
test('Context lane claims never set the session detection-override flag', () => {
  const contextPanel = sourceBlock('  _initGlobalContextPanel() {', '  async _runUserFacingContextAction(');
  const facade = sourceBlock('  async setContextMode(mode, {', '  getCockpitState() {');
  for (const [block, label] of [
    [contextPanel, 'Context panel'],
    [facade, 'setContextMode facade'],
  ]) {
    assert.ok(
      !block.includes('_detectionUserOverridden = true'),
      `${label} must not flag the operator as having overridden detection`,
    );
  }
});

test('every explicit visual control facade claims restore authority before mutation', () => {
  const facadeRoutes = [
    ['  setHudVisible(mode) {', '  setHudLayout(variantName) {', 'this.hud.setMode(', 'setHudVisible'],
    ['  setHudLayout(variantName) {', '  getDetectionState() {', 'this._setHudVariant(', 'setHudLayout'],
    ['  setDetection({ enabled, mode, densityPct, allocationStrategy, fadePct, outsideOpacityPct } = {}) {', '  async setMapStack(stackId) {', 'this._setDetectionAllocation(', 'setDetection'],
    ['  setBloom({ enabled, intensityPct } = {}) {', '  setSharpen({ enabled, intensityPct } = {}) {', 'this._setBloomIntensity(', 'setBloom'],
    ['  setSharpen({ enabled, intensityPct } = {}) {', '  get celestialRingEnabled() {', 'this._applySharpenIntensity(', 'setSharpen'],
    ['  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {', '  setOrbit(enabled) {', 'this.celestialRing?.setEnabled(', 'setCelestialRingEnabled'],
  ];
  for (const [start, end, mutation, label] of facadeRoutes) {
    assertClaimsBefore(sourceBlock(start, end), mutation, label);
  }

  const style = sourceBlock('  setStyle(styleName, {', '  _startTransition(styleName, fromValue, toValue) {');
  assertClaimsBefore(style, 'this.activeStyle = styleName', 'setStyle');
  const sliders = sourceBlock('  _updateSliderPanel(styleName, { reveal = false } = {}) {', '  _revealStyleParameters() {');
  assertClaimsBefore(sliders, 'this.stages[styleName].uniforms[uName] = val', 'style parameter slider');
});

test('public visual facades reject the complete invalid request before authority or mutation', () => {
  const cases = [
    {
      label: 'setDetection',
      block: sourceBlock(
        '  setDetection({ enabled, mode, densityPct, allocationStrategy, fadePct, outsideOpacityPct } = {}) {',
        '  async setMapStack(stackId) {',
      ),
      validations: ['enabled !== undefined', 'Invalid outside opacity'],
    },
    {
      label: 'setBloom',
      block: sourceBlock('  setBloom({ enabled, intensityPct } = {}) {', '  setSharpen({ enabled, intensityPct } = {}) {'),
      validations: ['Invalid bloom enabled value', 'Invalid bloom intensity'],
    },
    {
      label: 'setSharpen',
      block: sourceBlock('  setSharpen({ enabled, intensityPct } = {}) {', '  get celestialRingEnabled() {'),
      validations: ['Invalid sharpen enabled value', 'Invalid sharpen intensity'],
    },
    {
      label: 'setCelestialRingEnabled',
      block: sourceBlock(
        '  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {',
        '  setOrbit(enabled) {',
      ),
      validations: [
        'Invalid celestial ring enabled value',
        'Celestial ring options must be boolean',
        'Celestial ring is available only in Normal style',
      ],
    },
  ];
  for (const { label, block, validations } of cases) {
    const claimIndex = block.indexOf("claimRestoreLane?.('visual')");
    assert.ok(claimIndex >= 0, `${label} claim is missing`);
    for (const validation of validations) {
      const validationIndex = block.indexOf(validation);
      assert.ok(validationIndex >= 0, `${label} validation is missing: ${validation}`);
      assert.ok(validationIndex < claimIndex, `${label} must validate ${validation} before claiming`);
    }
  }
  assert.doesNotMatch(cases.at(-1).block, /!!enabled/);
});

test('share apply completion waits for both callback work and camera settlement', async () => {
  let flight = null;
  let releaseRestore;
  const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() {},
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, { onRestore: () => restoreGate });
  let settled = false;
  const applying = manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }).then((result) => { settled = true; return result; });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseRestore();
  await Promise.resolve();
  assert.equal(settled, false);
  flight.complete();
  const result = await applying;
  assert.equal(result.camera, 'applied');
  assert.equal(settled, true);
});

test('a later navigation prevents share completion from resetting the final pose', () => {
  let generation = 3;
  let flight = null;
  let setViews = 0;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() { setViews += 1; },
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
  });
  manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 3 });
  generation = 4;
  flight.complete();
  assert.equal(setViews, 0);
});

test('destroy cancels only a still-owned share flight and ignores delayed completion', () => {
  let generation = 7;
  let flight = null;
  let cancellations = 0;
  let setViews = 0;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() { setViews += 1; },
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
    cancelOwnedNavigation: () => { cancellations += 1; flight?.cancel?.(); },
  });
  manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 7 });
  manager.destroy();
  flight.complete();
  assert.equal(cancellations, 1);
  assert.equal(setViews, 0);

  const newerManager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
    cancelOwnedNavigation: () => { cancellations += 1; },
  });
  newerManager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 7 });
  generation = 8;
  newerManager.destroy();
  assert.equal(cancellations, 1, 'newer navigation must not be cancelled');
});
