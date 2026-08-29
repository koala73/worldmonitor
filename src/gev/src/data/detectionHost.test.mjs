import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  countFadingRenderEntries,
  destroyDetection,
  detectionDebugRequested,
  getDetectionDiagnostics,
  getDetectionTheme,
  getMode,
  initDetection,
  isDetectionSuspended,
  resumeDetection,
  setDetectionStyle,
  setDetectionTuning,
  setMode,
  suspendDetection,
} from './detection.js';
import {
  destroyWorldOverlay,
  initWorldOverlay,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { DETECTION_THEME_MAP } from '../overlays/worldOverlayTokens.js';

test('detection diagnostics count rendered fading rows instead of absent selected identities', () => {
  assert.equal(countFadingRenderEntries([
    { selected: true },
    { selected: false },
    { selected: true },
    { selected: false },
  ]), 2);
  assert.equal(countFadingRenderEntries([{ selected: true }, { selected: true }]), 0);
});

class MockEvent {
  constructor() { this.listeners = new Set(); }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  raise() {
    for (const listener of [...this.listeners]) listener();
  }
}

class MockPath2D {
  moveTo() {}
  lineTo() {}
  roundRect() {}
  arcTo() {}
  closePath() {}
}

function mockContext(target, trace) {
  const calls = [];
  const record = (...call) => {
    calls.push(call);
    trace.push([target, ...call]);
  };
  let filter = 'none';
  let strokeStyle = '';
  let globalCompositeOperation = 'source-over';
  return {
    calls,
    font: '',
    get filter() { return filter; },
    set filter(value) { filter = value; record('filter', value); },
    fillStyle: '',
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value) { strokeStyle = value; record('strokeStyle', value); },
    globalAlpha: 1,
    get globalCompositeOperation() { return globalCompositeOperation; },
    set globalCompositeOperation(value) { globalCompositeOperation = value; record('globalCompositeOperation', value); },
    lineWidth: 1,
    measureText(text) { return { width: String(text).length * 6 }; },
    setTransform(...args) { record('setTransform', ...args); },
    clearRect(...args) { record('clearRect', ...args); },
    save() { record('save'); },
    restore() { record('restore'); },
    translate(...args) { record('translate', ...args); },
    scale(...args) { record('scale', ...args); },
    beginPath() { record('beginPath'); },
    rect(...args) { record('rect', ...args); },
    clip(...args) { record('clip', ...args); },
    moveTo(...args) { record('moveTo', ...args); },
    lineTo(...args) { record('lineTo', ...args); },
    arc(...args) { record('arc', ...args); },
    arcTo(...args) { record('arcTo', ...args); },
    closePath() { record('closePath'); },
    // The style is recorded AT fill time, not on assignment, so a pin can prove
    // which plate token actually reached the canvas rather than which one was
    // set at some point during the frame. globalAlpha rides along for the same
    // reason: the backdrop feather is an alpha, not a colour.
    fill(path) { record('fill', path, this.fillStyle, this.globalAlpha); },
    stroke(path) { record('stroke', path); },
    fillRect(...args) { record('fillRect', ...args); },
    fillText(...args) { record('fillText', ...args); },
    drawImage(...args) { record('drawImage', ...args); },
  };
}

// `search` seeds window.location.search. The detection mode banner is developer
// telemetry gated behind ?detectDebug=1, so any test that uses the banner as its
// "did this frame repaint" probe must opt in explicitly.
function installEnvironment({ width = 800, height = 600, dpr = 2, search = '' } = {}) {
  const byId = new Map();
  const paintTrace = [];
  const ctx = mockContext('shared', paintTrace);
  const detectionCtx = mockContext('detection', paintTrace);
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalDateNow = Date.now;
  const originalPath2D = globalThis.Path2D;
  let currentTime = 1_000;
  let performanceStep = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => {
      const value = currentTime;
      currentTime += performanceStep;
      return value;
    } },
  });
  Date.now = () => currentTime;
  globalThis.Path2D = MockPath2D;

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.width = 0;
      this.height = 0;
      this.clientWidth = width;
      this.clientHeight = height;
      this._rect = { left: 0, top: 0, width, height };
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      register(child);
      return child;
    }

    insertBefore(child, before) {
      child.parentElement = this;
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      register(child);
      return child;
    }

    setAttribute(name, value) {
      if (name === 'id') this.id = String(value);
      else this[name] = String(value);
      register(this);
    }

    getBoundingClientRect() { return this._rect; }
    getContext() {
      if (this.tagName !== 'CANVAS') return null;
      return this.id === 'world-overlay-detection-surface' ? detectionCtx : ctx;
    }

    querySelector(selector) {
      const wanted = selector.slice(1);
      return this.children.find((child) => child.id === wanted) || null;
    }

    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      unregister(this);
      this.parentElement = null;
    }

    get nextSibling() { return null; }
  }

  function register(element) {
    if (element.id) byId.set(element.id, element);
    for (const child of element.children) register(child);
  }

  function unregister(element) {
    if (element.id) byId.delete(element.id);
    for (const child of element.children) unregister(child);
  }

  const body = new MockElement('body');
  body.classList = { contains() { return false; } };
  const document = {
    body,
    createElement(tagName) { return new MockElement(tagName); },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return byId.get(selector.slice(1)) || null; },
    querySelectorAll(selector) {
      const element = selector.startsWith('#') ? byId.get(selector.slice(1)) : null;
      return element ? [element] : [];
    },
  };
  const window = {
    devicePixelRatio: dpr,
    location: { search },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.document = document;
  globalThis.window = window;

  const container = new MockElement('div');
  container.id = 'cesiumContainer';
  body.appendChild(container);
  const root = new MockElement('div');
  root.id = 'world-overlay-root';
  body.appendChild(root);
  const canvas = new MockElement('canvas');
  canvas.id = 'world-overlay-canvas';
  root.appendChild(canvas);

  const postRender = new MockEvent();
  const viewer = {
    container,
    canvas: { clientWidth: width, clientHeight: height },
    camera: {
      positionWC: new Cesium.Cartesian3(0, 0, 10_000_000),
      positionCartographic: { height: 1_000_000 },
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY) },
      moveEnd: new MockEvent(),
    },
    scene: { postRender, requestRender() {} },
  };

  return {
    viewer,
    postRender,
    document,
    ctx,
    detectionCtx,
    paintTrace,
    advance(ms) { currentTime += ms; },
    setPerformanceStep(ms) { performanceStep = ms; },
    cleanup() {
      destroyDetection();
      destroyWorldOverlay();
      Date.now = originalDateNow;
      if (originalPath2D === undefined) delete globalThis.Path2D;
      else globalThis.Path2D = originalPath2D;
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.ResizeObserver;
      delete globalThis.MutationObserver;
      if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
      else delete globalThis.performance;
    },
  };
}

function detectableLayer() {
  const positions = [
    new Cesium.Cartesian3(0, 0, 6_356_752),
    new Cesium.Cartesian3(10_000, 0, 6_356_740),
  ];
  return {
    id: 'flights',
    getDetectableObjects() {
      return positions.map((position, index) => ({
        position,
        sourceId: `flight-${index}`,
        id: `TEST${index}`,
        metric: `FL${300 + index}`,
        type: 'AIR',
      }));
    },
  };
}

function militaryLayer() {
  return {
    id: 'military',
    getDetectableObjects() {
      return [{
        position: new Cesium.Cartesian3(0, 0, 6_356_752),
        sourceId: 'military-pin',
        id: 'MIL-PIN',
        metric: 'FL450',
        type: 'AIR',
        tier: 'military',
      }];
    },
  };
}

// One air contact and one space contact, both on screen. The mock camera
// projects through an identity view-projection, so a position's x/y ARE its
// normalized device coordinates; these two land ~320px apart and both survive
// the declutter.
function mixedTierLayer() {
  return {
    id: 'mixed',
    getDetectableObjects() {
      return [
        {
          position: new Cesium.Cartesian3(-0.4, 0.2, 6_356_752),
          sourceId: 'air-1',
          id: 'AIRONE',
          metric: 'FL350',
          type: 'AIR',
        },
        {
          position: new Cesium.Cartesian3(0.4, -0.2, 6_356_752),
          sourceId: 'sat-1',
          id: 'SATONE',
          metric: '412KM',
          type: 'SAT',
        },
      ];
    },
  };
}

/** Fill styles that actually reached the shared normal-blend canvas. */
function sharedFillStyles(env) {
  return env.ctx.calls
    .filter(([name]) => name === 'fill')
    .map(([, , fillStyle]) => fillStyle);
}

/** Settle a frame so the arbiter has promoted its identities to render entries. */
function settleFrame(env) {
  env.advance(250);
  env.postRender.raise();
}

test('detection lifecycle re-hosts unchanged painters behind the sole host listener', () => {
  // Opts into the telemetry banner: this test reads it as the repaint probe.
  const env = installEnvironment({ search: '?detectDebug=1' });
  const modes = [];
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], (mode) => modes.push(mode));
    assert.equal(env.postRender.listeners.size, 1);
    assert.equal(env.document.getElementById('detection-overlay'), null);
    assert.ok(env.document.getElementById('world-overlay-canvas'));
    const surface = env.document.getElementById('world-overlay-detection-surface');
    const root = env.document.getElementById('world-overlay-root');
    const mainCanvas = env.document.getElementById('world-overlay-canvas');
    assert.ok(surface);
    // The surface must sit in the Cesium container (no stacking context
    // between it and the WebGL canvas) or its `screen` blend is discarded;
    // ordering under the card canvas is carried by z-index, not siblinghood.
    assert.equal(surface.parentElement, env.viewer.container);
    assert.deepEqual(root.children, [mainCanvas]);
    assert.equal(surface.style.mixBlendMode, 'screen');
    assert.equal(
      surface.style.filter,
      'contrast(1.05) saturate(1.05) drop-shadow(0 0 3px rgba(0, 244, 255, 0.4))',
    );
    assert.equal(surface.style.display, 'none');

    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    const first = getDetectionDiagnostics();
    assert.equal(first.profile, 'DENSE');
    assert.equal(first.observationCount, 2);
    assert.equal(first.didSolve, true);
    assert.ok(first.solveRevision > 0);
    assert.ok(first.collectiveLabelBudget > 0);
    assert.ok(first.bracketOpacityCounts.full + first.bracketOpacityCounts.partial > 0);
    assert.ok(env.detectionCtx.calls.some(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')));
    assert.ok(env.detectionCtx.calls.some(([name, path]) => name === 'stroke' && path instanceof MockPath2D));
    assert.ok(env.detectionCtx.calls.some(([name]) => name === 'fillRect'), 'scanlines and banner still paint');
    assert.equal(env.detectionCtx.globalCompositeOperation, 'source-over');
    assert.equal(env.detectionCtx.filter, 'none');
    assert.equal(surface.style.display, 'block');
    const canvas = env.document.getElementById('world-overlay-canvas');
    assert.equal(Number(canvas.dataset.solveRevision), first.solveRevision);
    assert.equal(canvas.dataset.profile, 'DENSE');

    // The existing 125 ms arbiter cadence remains authoritative.
    env.advance(124);
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().solveRevision, first.solveRevision);
    // Callsigns paint on the SHARED normal-blend canvas, never on the
    // screen-blended sensor surface: `screen` can only lighten, so a callout's
    // dark backing plate is a no-op over sunlit ground and the text dissolves
    // into it. Brackets, banner and scanlines stay on the sensor surface.
    assert.ok(env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'TEST0'));
    assert.ok(!env.detectionCtx.calls.some(([name, text]) => name === 'fillText' && text === 'TEST0'));
    env.advance(1);
    env.postRender.raise();
    assert.ok(getDetectionDiagnostics().solveRevision > first.solveRevision);

    setDetectionTuning({ densityPct: 25, allocationStrategy: 'WEIGHTED' });
    env.postRender.raise();
    assert.equal(getMode(), 'SPARSE');
    assert.equal(getDetectionDiagnostics().profile, 'SPARSE');
    assert.equal(getDetectionDiagnostics().allocationStrategy, 'WEIGHTED');
    assert.ok(env.detectionCtx.calls.some(([name]) => name === 'arc'), 'sparse focus ring remains available');

    setMode('BALANCED');
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().profile, 'BALANCED');
    setMode('DENSE');
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().profile, 'DENSE');

    const bannerCount = () => env.detectionCtx.calls.filter(([name, text]) => (
      name === 'fillText' && /^(SPARSE|BALANCED|DENSE)  VIS:/.test(String(text))
    )).length;
    const beforeSuspend = bannerCount();
    suspendDetection('intercity');
    assert.equal(isDetectionSuspended(), true);
    assert.equal(surface.style.opacity, '0');
    env.postRender.raise();
    assert.equal(bannerCount(), beforeSuspend);
    assert.equal(env.postRender.listeners.size, 1);
    resumeDetection();
    env.postRender.raise();
    assert.equal(isDetectionSuspended(), false);
    assert.equal(surface.style.opacity, '1');
    assert.ok(bannerCount() > beforeSuspend);

    // These are the exact engine calls made by military style presets after
    // their production UI gate chooses CRT/NVG/FLIR defaults.
    const expectedThemes = {
      retro: 'contrast(1.08) saturate(1.04) drop-shadow(0 0 3px rgba(255, 176, 56, 0.45))',
      surveillance: 'contrast(1.12) saturate(1.12) drop-shadow(0 0 3px rgba(120, 255, 120, 0.42))',
      thermal: 'contrast(1.1) saturate(1.08) drop-shadow(0 0 3px rgba(255, 224, 170, 0.42))',
    };
    for (const style of ['retro', 'surveillance', 'thermal']) {
      setMode('OFF');
      setDetectionStyle(style);
      assert.equal(surface.style.mixBlendMode, 'screen');
      assert.equal(surface.style.filter, expectedThemes[style]);
      setDetectionTuning({ densityPct: 75 });
      setMode('DENSE');
      env.postRender.raise();
      assert.equal(getDetectionDiagnostics().profile, 'DENSE');
      assert.ok(getDetectionTheme().line);
      assert.equal(env.postRender.listeners.size, 1);
    }

    setMode('OFF');
    setDetectionStyle('normal');
    assert.equal(surface.style.mixBlendMode, 'screen');
    assert.equal(
      surface.style.filter,
      'contrast(1.05) saturate(1.05) drop-shadow(0 0 3px rgba(0, 244, 255, 0.4))',
    );
    env.postRender.raise();
    assert.equal(getMode(), 'OFF');
    assert.equal(surface.style.display, 'none');
    assert.equal(env.postRender.listeners.size, 1);
    assert.ok(modes.includes('SPARSE') && modes.includes('BALANCED') && modes.includes('DENSE'));

    destroyDetection();
    assert.equal(env.postRender.listeners.size, 1, 'detection never owns the listener');
    setMode('DENSE');
    env.postRender.raise();
    assert.equal(env.document.getElementById('detection-overlay'), null);
    destroyWorldOverlay();
    assert.equal(env.postRender.listeners.size, 0);
    assert.equal(env.document.getElementById('world-overlay-canvas'), null);
    assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  } finally {
    env.cleanup();
  }
});

test('callouts stop painting the moment the last detectable object goes away', () => {
  // The callout lane replays the previous solve on frames the sensor lane
  // skips under load, which is what keeps plates from strobing against
  // persistent brackets. The cost of that design is that an empty field MUST
  // clear the replay buffer, or the final callsigns stay stranded on the
  // shared canvas after the last data layer is switched off.
  const env = installEnvironment();
  let objects = [{
    position: new Cesium.Cartesian3(0, 0, 6_356_752),
    sourceId: 'lonely-1',
    id: 'LASTONE',
    metric: 'FL120',
    type: 'AIR',
  }];
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'flights', getDetectableObjects: () => objects }], () => {});
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    // The first frame solves; the arbiter hands the identity back as a render
    // entry on the frame after that.
    env.advance(250);
    env.postRender.raise();
    assert.ok(
      env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'LASTONE'),
      'the callout paints on the shared canvas while the contact exists',
    );

    objects = [];
    env.ctx.calls.length = 0;
    env.advance(250);
    env.postRender.raise();
    env.advance(250);
    env.postRender.raise();
    assert.ok(
      !env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'LASTONE'),
      'an empty field must drop the replay buffer, not strand the last callsign',
    );
  } finally {
    env.cleanup();
  }
});

test('every style paints its OWN plate token through the production callout path', () => {
  // The token table and the direct painter are both pinned elsewhere, but a
  // pin on either one still passes if the runtime stops consulting the active
  // theme and freezes on a single plate. This drives the real stash → replay
  // path once per style and reads the fill style the shared canvas received.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [mixedTierLayer()], () => {});
    setMode('DENSE');
    settleFrame(env);
    settleFrame(env);

    for (const style of ['surveillance', 'retro', 'thermal', 'normal']) {
      setDetectionStyle(style);
      settleFrame(env);
      env.ctx.calls.length = 0;
      settleFrame(env);

      const theme = DETECTION_THEME_MAP[style] || DETECTION_THEME_MAP._default;
      const fills = sharedFillStyles(env);
      assert.ok(
        fills.includes(theme.calloutPlate),
        `${style} must paint its own callout plate (${theme.calloutPlate})`,
      );
      for (const [otherName, other] of Object.entries(DETECTION_THEME_MAP)) {
        if (other.calloutPlate === theme.calloutPlate) continue;
        assert.ok(
          !fills.includes(other.calloutPlate),
          `${style} must not paint the ${otherName} plate`,
        );
      }
    }
  } finally {
    env.cleanup();
  }
});

test('space-tier callouts take the heavier plate while air contacts keep the light one', () => {
  // Satellites sit over the high-albedo lit Earth disc far more often than
  // aircraft do, so the space tier carries the heavier backing. Losing the
  // tier split is invisible to the token table — only a frame carrying BOTH
  // tiers at once can show it.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [mixedTierLayer()], () => {});
    setDetectionStyle('surveillance');
    setMode('DENSE');
    settleFrame(env);
    env.ctx.calls.length = 0;
    settleFrame(env);

    const theme = DETECTION_THEME_MAP.surveillance;
    assert.notEqual(
      theme.calloutPlate,
      theme.calloutPlateSpace,
      'the fixture is only meaningful while the two tiers differ',
    );
    const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
    assert.ok(painted('AIRONE') && painted('SATONE'), 'both tiers reached the frame under test');

    const fills = sharedFillStyles(env);
    assert.ok(fills.includes(theme.calloutPlate), 'the air contact keeps the light plate');
    assert.ok(fills.includes(theme.calloutPlateSpace), 'the space contact takes the heavier plate');
  } finally {
    env.cleanup();
  }
});

test('surveillance military tier reaches the dedicated render target as shipped red', () => {
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [militaryLayer()], () => {});
    setDetectionStyle('surveillance');
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();

    assert.ok(
      env.detectionCtx.calls.some(([name, value]) => name === 'strokeStyle' && value === '#ff5a47'),
      'the production projection/tier/batched-bracket paint path emits surveillance military red',
    );
    assert.ok(env.detectionCtx.calls.some(([name, path]) => name === 'stroke'
      && path instanceof MockPath2D));
  } finally {
    env.cleanup();
  }
});

test('pathological detection paint holds alternate frames without freezing shared lanes', () => {
  // Opts into the telemetry banner: the held-frame assertions count banner paints.
  const env = installEnvironment({ search: '?detectDebug=1' });
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], () => {});
    setOverlayEntries('valve-card', [{
      id: 'ambient-card',
      position: new Cesium.Cartesian3(0, 0, 0),
      variant: 'label',
      title: 'AMBIENT-CONTINUES',
      selected: true,
      protected: true,
      horizonCull: false,
      edgeFade: 'none',
    }]);
    setMode('DENSE');
    env.advance(250);
    env.setPerformanceStep(30);

    env.postRender.raise();
    env.postRender.raise();
    const detectionClears = env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length;
    const detectionBanners = env.detectionCtx.calls.filter(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')).length;
    const sharedClears = env.ctx.calls.filter(([name]) => name === 'clearRect').length;
    const sharedCards = env.ctx.calls.filter(([name, text]) => name === 'fillText'
      && text === 'AMBIENT-CONTINUES').length;

    env.postRender.raise();
    assert.equal(env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length, detectionClears,
      'the host preserves detection pixels on the held odd frame');
    assert.equal(env.detectionCtx.calls.filter(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')).length, detectionBanners);
    assert.equal(env.ctx.calls.filter(([name]) => name === 'clearRect').length, sharedClears + 1,
      'the shared surface still clears');
    assert.equal(env.ctx.calls.filter(([name, text]) => name === 'fillText'
      && text === 'AMBIENT-CONTINUES').length, sharedCards + 1,
      'the shared lane still repaints');
    assert.equal(getDetectionDiagnostics().throttleSkipCount, 1);

    env.postRender.raise();
    assert.equal(env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length,
      detectionClears + 1, 'the next even frame repaints detection');
    assert.equal(getDetectionDiagnostics().throttleSkipCount, 1);
  } finally {
    env.cleanup();
  }
});

test('detection cannot resurrect a private canvas, listener, matrix, resize, clear, or UI inventory', () => {
  const source = readFileSync(new URL('./detection.js', import.meta.url), 'utf8');
  const uiSource = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createElement\(\s*['"]canvas['"]\s*\)/);
  assert.doesNotMatch(source, /postRender\.addEventListener/);
  assert.doesNotMatch(source, /['"]detection-overlay['"]/);
  assert.doesNotMatch(source, /devicePixelRatio/);
  assert.doesNotMatch(source, /clearRect\(/);
  assert.doesNotMatch(source, /Matrix4\.multiply/);
  assert.doesNotMatch(source, /CALLOUT_OCCLUSION_SELECTORS/);
  assert.doesNotMatch(source, /_ctx\.(?:filter|globalCompositeOperation)\s*=/);
  assert.match(source, /_hostSurface\.style\.mixBlendMode = _theme\.blend;/);
  assert.match(source, /_hostSurface\.style\.filter = `\$\{_theme\.filter\} drop-shadow\(0 0 \$\{GLOW_PX\}px \$\{_theme\.glow\}\)`;/);
  assert.match(source, /const LABEL_SOLVE_INTERVAL_MS = 125;/);
  assert.match(source, /const _labelArbiter = new LabelArbiter\(\);/);
  assert.match(source, /const clipW = vp3 \* px \+ vp7 \* py \+ vp11 \* pz \+ vp15;/);
  assert.match(source, /registerWorldOverlayPaintLane\('detection', _paintDetectionLane/);
  assert.match(source, /target: 'detection'/);
  assert.match(source, /shouldPaint: _shouldPaintDetectionLane/);
  // The three military styles used to carry three copies of these numbers.
  // They now share ONE frozen object, which Cockpit's force-on reuses too, so
  // the pin moved from "three identical literals" to "one preset, referenced
  // three times" — same guarantee, and the copies can no longer drift.
  assert.match(
    uiSource,
    /const MILITARY_DETECTION_PRESET = Object\.freeze\(\{ mode: 'dense', densityPct: 75 \}\);/,
    'the tactical detection default is still Dense @ 75%',
  );
  assert.equal(
    uiSource.match(/detection: MILITARY_DETECTION_PRESET,/g)?.length,
    3,
    'CRT, NVG, and FLIR retain their Dense auto-enable defaults',
  );
  assert.match(uiSource, /preset\.detection && !this\._detectionUserOverridden/);
});

// ── Developer telemetry gate (2026-08-20 QA hunt) ───────────────────────────
// The orange mode banner ("DENSE  VIS:15  SRC:1036  DENS:100%  ELASTIC  0.4ms")
// painted for every user: CRT/NVG/FLIR auto-enable detection, so engine
// telemetry was the first thing a visitor saw, overlapping the cockpit callsign
// block. It is kept as a debug affordance, but must default OFF.
test('detectionDebugRequested parses the query-string gate and nothing else', () => {
  assert.equal(detectionDebugRequested('?detectDebug=1'), true);
  assert.equal(detectionDebugRequested('?foo=bar&detectDebug=1'), true);
  assert.equal(detectionDebugRequested(''), false);
  assert.equal(detectionDebugRequested('?detectDebug=0'), false);
  assert.equal(detectionDebugRequested('?detectDebug'), false);
  assert.equal(detectionDebugRequested('?detectdebug=1'), false, 'the flag is case-sensitive');
  assert.equal(detectionDebugRequested(undefined), false);
  assert.equal(detectionDebugRequested(null), false);
});

test('the mode banner is absent by default and present behind the flag', () => {
  const bannerPaints = (env) => env.detectionCtx.calls.filter(([name, text]) => (
    name === 'fillText' && /^(SPARSE|BALANCED|DENSE)  VIS:/.test(String(text))
  )).length;

  const painted = (search) => {
    const env = installEnvironment({ search });
    try {
      initWorldOverlay(env.viewer);
      initDetection(env.viewer, [detectableLayer()], () => {});
      setMode('DENSE');
      env.advance(250);
      env.postRender.raise();
      // The overlay is alive either way — brackets still stroke.
      assert.ok(
        env.detectionCtx.calls.some(([name, path]) => name === 'stroke' && path instanceof MockPath2D),
        'detection still paints its contacts regardless of the debug gate',
      );
      return bannerPaints(env);
    } finally {
      destroyDetection();
      destroyWorldOverlay();
      env.cleanup();
    }
  };

  assert.equal(painted(''), 0, 'users must never see the engine telemetry banner');
  assert.ok(painted('?detectDebug=1') > 0, 'the flag brings the telemetry back');
});

test('detection telemetry stays reachable programmatically with the banner hidden', () => {
  // Hiding the banner must not remove the numbers — getDetectionDiagnostics()
  // is the supported way to read them, and is what the QA harnesses use.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], () => {});
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    const diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.profile, 'DENSE');
    assert.equal(typeof diagnostics.observationCount, 'number');
    assert.equal(typeof diagnostics.visibleCount, 'number');
    assert.equal(typeof diagnostics.densityPct, 'number');
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('civilian and military AIR brackets cover front, left, and right at Sparse density', () => {
  for (const layerId of ['flights', 'military']) {
    const env = installEnvironment({ width: 900, height: 600, dpr: 1 });
    try {
      const objects = [-0.82, 0, 0.82].map((x, index) => ({
        position: new Cesium.Cartesian3(x, 0, 6_356_752),
        sourceId: `${layerId}-${index}`,
        id: `${layerId.toUpperCase()}-${index}`,
        metric: 'FL120',
        type: 'AIR',
      }));
      initWorldOverlay(env.viewer);
      initDetection(env.viewer, [{ id: layerId, getDetectableObjects: () => objects }], () => {});
      setDetectionTuning({ densityPct: 25 });
      setMode('SPARSE');
      settleFrame(env);
      const diagnostics = getDetectionDiagnostics();
      assert.deepEqual(
        diagnostics.aircraftBracketSectors,
        { left: 1, front: 1, right: 1 },
        `${layerId} side brackets must not be starved by the central keyhole`,
      );
      assert.equal(diagnostics.visibleCount, 3);
      assert.equal(diagnostics.densityPct, 25);
      assert.equal(diagnostics.profile, 'SPARSE');
      assert.ok(diagnostics.selectedCount <= diagnostics.collectiveLabelBudget,
        'Sparse keeps its documented budget instead of silently becoming Dense');
    } finally {
      destroyDetection();
      destroyWorldOverlay();
      env.cleanup();
    }
  }
});

/**
 * Two air contacts at the same screen radius, one with the planet behind it and
 * one with sky. The mock camera sits at (0, 0, 10 000 km) and projects through
 * an identity view-projection, so a position's x/y ARE its NDC and z is free:
 * the pole-surface contact looks straight down the axis into the planet, while
 * its mirror sits 10 000 km FURTHER out, so the view ray through it escapes.
 * Equal screen radius keeps the keyhole's radial fade identical for both, which
 * makes the two painted plate alphas directly comparable.
 */
function backdropLayer() {
  return {
    id: 'flights',
    getDetectableObjects() {
      return [
        {
          position: new Cesium.Cartesian3(-0.4, 0.2, 6_356_752),
          sourceId: 'ground-1', id: 'GROUNDED', metric: 'FL100', type: 'AIR',
        },
        {
          position: new Cesium.Cartesian3(0.4, -0.2, 20_000_000),
          sourceId: 'sky-1', id: 'SKYBACK', metric: 'FL400', type: 'AIR',
        },
      ];
    },
  };
}

test('the backdrop feather reaches the canvas as a lighter plate against sky', () => {
  // The discriminator and the painter are pinned in their own modules, but both
  // pins still pass if detection stops carrying the factor between them. This
  // drives the real collect → solve → stash → replay path and reads the alpha
  // the shared canvas actually received for each plate.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [backdropLayer()], () => {});
    setDetectionStyle('normal');
    setMode('DENSE');
    settleFrame(env);
    env.ctx.calls.length = 0;
    settleFrame(env);

    const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
    assert.ok(painted('GROUNDED') && painted('SKYBACK'), 'both backdrops reached the frame under test');

    const plate = DETECTION_THEME_MAP._default.calloutPlate;
    const plateAlphas = env.ctx.calls
      .filter(([name, , fillStyle]) => name === 'fill' && fillStyle === plate)
      .map(([, , , globalAlpha]) => globalAlpha);
    assert.equal(plateAlphas.length, 2, 'exactly one plate per contact');

    const heaviest = Math.max(...plateAlphas);
    const lightest = Math.min(...plateAlphas);
    assert.ok(heaviest > 0, 'the grounded contact still gets a plate');
    assert.ok(lightest > 0, 'the sky contact keeps a whisper rather than vanishing');
    // Reverting the feature makes both plates equal, which fails here first.
    assert.ok(
      lightest < heaviest * 0.5,
      `sky plate ${lightest} must be markedly lighter than ground plate ${heaviest}`,
    );
  } finally {
    env.cleanup();
  }
});
