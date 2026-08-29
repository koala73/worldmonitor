import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  getKeyholeGeometry,
  keyholeLabelAlphaFromGeometry,
  setKeyholeFadeTuning,
} from '../celestialRing.js';
import { createCctvThumbnailOverlayEntry, createFrameSlot } from '../data/cctvCards.js';
import { combinedOverlayAlpha } from './worldOverlayDraw.js';
import {
  AMBIENT_CARD_COLLISION_CAPACITY,
  WORLD_OVERLAY_OCCLUDER_SELECTORS,
  WORLD_OVERLAY_PAINT_LANES,
  clearOverlaySource,
  destroyWorldOverlay,
  getOverlayPaintRect,
  getWorldOverlayDiagnostics,
  hitTestWorldOverlay,
  initWorldOverlay,
  isOverlayPointVisible,
  normalizeOverlayEntry,
  paintLaneForOverlayEntry,
  registerWorldOverlayPaintLane,
  removeOverlayEntry,
  selectBoundedOverlayCohort,
  setOverlayEntries,
  setOverlaySourceVisible,
  upsertOverlayEntry,
} from './worldOverlay.js';

class MockEvent {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  raise(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

function mockContext(target, trace) {
  const calls = [];
  const record = (...call) => {
    calls.push(call);
    trace.push([target, ...call]);
  };
  let strokeStyle = '';
  let lineWidth = 1;
  return {
    calls,
    font: '',
    globalAlpha: 1,
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value) { strokeStyle = value; record('strokeStyle', value); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value) { lineWidth = value; record('lineWidth', value); },
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
    roundRect(...args) { record('roundRect', ...args); },
    moveTo(...args) { record('moveTo', ...args); },
    lineTo(...args) { record('lineTo', ...args); },
    arcTo(...args) { record('arcTo', ...args); },
    closePath() { record('closePath'); },
    fill() { record('fill'); },
    stroke() { record('stroke'); },
    fillRect(...args) { record('fillRect', ...args); },
    fillText(...args) { record('fillText', ...args); },
    drawImage(...args) { record('drawImage', ...args); },
  };
}

function installMockEnvironment({
  width = 400,
  height = 300,
  dpr = 2,
  occluderRect = null,
  occluders = [],
} = {}) {
  const byId = new Map();
  const paintTrace = [];
  const ctx = mockContext('shared', paintTrace);
  const detectionCtx = mockContext('detection', paintTrace);
  const layoutReads = { canvasWidth: 0, canvasHeight: 0, boundingClientRect: 0 };
  const selectorQueries = { matches: 0, querySelector: 0, querySelectorAll: 0 };
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let currentTime = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => currentTime },
  });

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this._listeners = new Map();
      this._classes = new Set();
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

    addEventListener(name, listener) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set());
      this._listeners.get(name).add(listener);
    }

    click() {
      for (const listener of [...(this._listeners.get('click') || [])]) listener({ target: this });
    }

    replaceChildren(...children) {
      for (const child of this.children) {
        unregister(child);
        child.parentElement = null;
      }
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    getBoundingClientRect() {
      layoutReads.boundingClientRect++;
      return this._rect;
    }

    getContext() {
      if (this.tagName !== 'CANVAS') return null;
      return this.id === 'world-overlay-detection-surface' ? detectionCtx : ctx;
    }

    querySelector(selector) {
      selectorQueries.querySelector++;
      if (!selector.startsWith('#')) return null;
      const wanted = selector.slice(1);
      const queue = [...this.children];
      while (queue.length) {
        const item = queue.shift();
        if (item.id === wanted) return item;
        queue.push(...item.children);
      }
      return null;
    }

    matches(selector) {
      selectorQueries.matches++;
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
      return false;
    }

    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      unregister(this);
      this.parentElement = null;
    }

    get nextSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] || null;
    }
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
  body.classList = {
    values: new Set(),
    contains(name) { return this.values.has(name); },
    add(name) { this.values.add(name); },
    remove(name) { this.values.delete(name); },
  };
  const document = {
    body,
    createElement(tagName) { return new MockElement(tagName); },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) {
      selectorQueries.querySelector++;
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      selectorQueries.querySelectorAll++;
      if (selector.startsWith('#')) {
        const element = byId.get(selector.slice(1));
        return element ? [element] : [];
      }
      const matches = [];
      const visit = (node) => {
        if (node.matches?.(selector)) matches.push(node);
        for (const child of node.children) visit(child);
      };
      visit(body);
      return matches;
    },
  };

  const listenerMap = new Map();
  const window = {
    devicePixelRatio: dpr,
    addEventListener(name, listener) {
      if (!listenerMap.has(name)) listenerMap.set(name, new Set());
      listenerMap.get(name).add(listener);
    },
    removeEventListener(name, listener) { listenerMap.get(name)?.delete(listener); },
    dispatch(name, event = {}) {
      for (const listener of [...(listenerMap.get(name) || [])]) listener(event);
    },
    listenerCount(name) { return listenerMap.get(name)?.size || 0; },
    getComputedStyle(element) {
      const style = element?.style || {};
      return {
        display: style.display || 'block',
        visibility: style.visibility || 'visible',
        opacity: style.opacity ?? '1',
        position: style.position || 'static',
        zIndex: style.zIndex || 'auto',
        isolation: style.isolation || 'auto',
        filter: style.filter || 'none',
        transform: style.transform || 'none',
        mixBlendMode: style.mixBlendMode || 'normal',
      };
    },
  };

  const resizeObservers = [];
  const mutationObservers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observations = [];
      this.disconnected = false;
      mutationObservers.push(this);
    }

    observe(target, options) { this.observations.push({ target, options }); }
    disconnect() { this.disconnected = true; }
  };
  globalThis.document = document;
  globalThis.window = window;

  const viewerContainer = new MockElement('div');
  viewerContainer.id = 'cesiumContainer';
  body.appendChild(viewerContainer);
  const root = new MockElement('div');
  root.id = 'world-overlay-root';
  body.appendChild(root);
  const canvas = new MockElement('canvas');
  canvas.id = 'world-overlay-canvas';
  root.appendChild(canvas);
  if (occluderRect) {
    const title = new MockElement('div');
    title.id = 'title-bar';
    title._rect = occluderRect;
    Object.assign(title.style, shippedStacking('#title-bar'));
    body.appendChild(title);
  }
  // Named chrome fixtures. Every fixture declares whether its selector is
  // supposed to be in the shipped inventory and that claim is verified here,
  // so a fixture can neither exclude on a selector the host does not carry nor
  // silently start excluding if someone re-adds a dropped selector.
  for (const spec of occluders) {
    const selector = spec.selector || `#${spec.id}`;
    assert.equal(
      WORLD_OVERLAY_OCCLUDER_SELECTORS.includes(selector),
      spec.inInventory !== false,
      `${selector} inventory membership does not match what this fixture assumes`,
    );
    const element = new MockElement('div');
    if (selector.startsWith('#')) element.id = selector.slice(1);
    else element._classes.add(selector.slice(1));
    element._rect = spec.rect;
    if (spec.hidden) element.hidden = true;
    // Fixtures stack exactly as the shipped stylesheet says they do.
    Object.assign(element.style, shippedStacking(selector));
    if (spec.style) Object.assign(element.style, spec.style);
    // Chrome nested inside another stacking context (HUD corners live inside
    // #intel-hud) must be parented so the classifier walks the real chain.
    let parent = body;
    if (spec.parent) {
      parent = new MockElement('div');
      parent.id = spec.parent.slice(1);
      Object.assign(parent.style, shippedStacking(spec.parent));
      body.appendChild(parent);
    }
    parent.appendChild(element);
  }

  const postRender = new MockEvent();
  const moveEnd = new MockEvent();
  let viewerCanvasWidth = width;
  let viewerCanvasHeight = height;
  const viewerCanvas = {};
  Object.defineProperties(viewerCanvas, {
    clientWidth: {
      get() { layoutReads.canvasWidth++; return viewerCanvasWidth; },
      set(value) { viewerCanvasWidth = value; },
    },
    clientHeight: {
      get() { layoutReads.canvasHeight++; return viewerCanvasHeight; },
      set(value) { viewerCanvasHeight = value; },
    },
  });
  const viewer = {
    container: viewerContainer,
    canvas: viewerCanvas,
    camera: {
      positionWC: new Cesium.Cartesian3(0, 0, 10_000_000),
      positionCartographic: { height: 1000 },
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY) },
      moveEnd,
    },
    scene: {
      postRender,
      requestRenderCount: 0,
      requestRender() { this.requestRenderCount++; },
    },
  };

  return {
    viewer,
    ctx,
    detectionCtx,
    paintTrace,
    document,
    window,
    postRender,
    moveEnd,
    resizeObservers,
    mutationObservers,
    layoutReads,
    selectorQueries,
    advanceTime(ms) { currentTime += ms; },
    cleanup() {
      destroyWorldOverlay();
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.ResizeObserver;
      delete globalThis.MutationObserver;
      if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
      else delete globalThis.performance;
    },
  };
}

function position() {
  return new Cesium.Cartesian3(0, 0, 0);
}

function selectedEntry(id, overrides = {}) {
  return {
    id,
    position: overrides.position || position(),
    variant: overrides.variant || 'label',
    title: overrides.title || id,
    selected: overrides.selected ?? true,
    protected: overrides.protected ?? true,
    horizonCull: false,
    edgeFade: 'none',
    collisionGroup: overrides.collisionGroup || id,
    interactive: overrides.interactive === true,
    paintLane: overrides.paintLane,
    zIndex: overrides.zIndex,
    ...overrides,
  };
}

// MUST STAY FIRST in this file: it asserts the module's never-initialized
// state, which every later test destroys.
test('destroying before the first init leaves pre-init buffering intact', () => {
  const env = installMockEnvironment();
  destroyWorldOverlay();
  setOverlayEntries('pre-init', [selectedEntry('buffered')]);
  assert.equal(getWorldOverlayDiagnostics().entryCount, 1);

  initWorldOverlay(env.viewer);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);

  // A real teardown does arm the guard, and repeating it must not disarm it.
  destroyWorldOverlay();
  destroyWorldOverlay();
  setOverlayEntries('pre-init', [selectedEntry('rejected')]);
  assert.equal(getWorldOverlayDiagnostics().entryCount, 0);
  env.cleanup();
});

test('lifecycle is idempotent and teardown removes listeners, observers, and DOM', () => {
  const env = installMockEnvironment();
  assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  initWorldOverlay(env.viewer);
  initWorldOverlay(env.viewer);
  assert.equal(env.postRender.listeners.size, 1);
  assert.equal(env.moveEnd.listeners.size, 1);
  assert.equal(env.window.listenerCount('gev:cockpit-mode-changed'), 1);
  assert.equal(env.document.getElementById('world-overlay-root') !== null, true);
  const root = env.document.getElementById('world-overlay-root');
  const surface = env.document.getElementById('world-overlay-detection-surface');
  const canvas = env.document.getElementById('world-overlay-canvas');
  assert.ok(surface, 'the host creates the detection blend surface');
  assert.equal(surface.parentElement, env.viewer.container,
    'the detection surface is parented into the Cesium container, not the overlay root');
  assert.deepEqual(root.children, [canvas],
    'the overlay root carries only the shared card canvas');
  assert.doesNotMatch(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
    /world-overlay-detection-surface/,
    'the surface is runtime host-owned, not static markup',
  );
  assert.match(
    readFileSync(new URL('../../style.css', import.meta.url), 'utf8'),
    /#world-overlay-detection-surface,\n#world-overlay-canvas \{\n  position: absolute;\n  inset: 0;[\s\S]*?pointer-events: none;/,
    'both host surfaces share absolute positioning and pointer passthrough',
  );

  destroyWorldOverlay();
  assert.equal(env.postRender.listeners.size, 0);
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.window.listenerCount('gev:cockpit-mode-changed'), 0);
  assert.equal(env.document.getElementById('world-overlay-root'), null);
  assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  assert.ok(env.resizeObservers.every((observer) => observer.disconnected));
  assert.ok(env.mutationObservers.every((observer) => observer.disconnected));
  env.cleanup();
});

/** The shipped stylesheet, read once — fixtures must stack as production does. */
const SHIPPED_CSS = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');

/**
 * Position + z-index the SHIPPED stylesheet gives a selector. Fixtures are built
 * from this rather than from invented numbers, so a stacking change in style.css
 * moves these tests instead of silently invalidating them.
 */
function shippedStacking(selector) {
  const declarations = cssDeclarationsFor(SHIPPED_CSS, selector);
  return {
    position: declarations.position || 'static',
    zIndex: declarations['z-index'] || 'auto',
  };
}

/** Collect every declaration the shipped stylesheet applies to a selector. */
function cssDeclarationsFor(css, selector) {
  const declarations = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = rulePattern.exec(withoutComments);
  while (match !== null) {
    const selectors = match[1].split(',').map((selector) => selector.trim());
    if (selectors.includes(selector)) {
      for (const declaration of match[2].split(';')) {
        const split = declaration.indexOf(':');
        if (split < 0) continue;
        declarations[declaration.slice(0, split).trim()] = declaration.slice(split + 1).trim();
      }
    }
    match = rulePattern.exec(withoutComments);
  }
  return declarations;
}

/**
 * The exact predicate the live browser probe used: does this element form a
 * stacking context? A stacking context is an isolated blending group, so any
 * such ancestor makes the browser discard a descendant canvas's
 * `mix-blend-mode: screen` while the CSS string itself stays `'screen'` —
 * which is why every string-level pin stayed green through the regression.
 */
function formsStackingContext(declarations = {}) {
  const position = declarations.position || 'static';
  const zIndex = declarations['z-index'] || 'auto';
  const opacity = declarations.opacity === undefined ? 1 : Number(declarations.opacity);
  const isSet = (name) => declarations[name] !== undefined && declarations[name] !== 'none';
  return (position === 'fixed' || position === 'sticky')
    || (position !== 'static' && zIndex !== 'auto')
    || declarations.isolation === 'isolate'
    || isSet('filter')
    || isSet('backdrop-filter')
    || isSet('transform')
    || isSet('perspective')
    || isSet('will-change')
    || isSet('contain')
    || (declarations['mix-blend-mode'] !== undefined && declarations['mix-blend-mode'] !== 'normal')
    || (Number.isFinite(opacity) && opacity < 1);
}

test('no ancestor isolates the detection surface, so `screen` reaches the scene', () => {
  // MECHANISM PIN. The candidate regression was invisible to every existing
  // assertion because they check the blend *string*, which never changed; what
  // changed was containment. This walks the ancestor chain the host actually
  // builds and evaluates each node against the shipped stylesheet.
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const surface = env.document.getElementById('world-overlay-detection-surface');
  assert.ok(surface, 'the host owns a detection surface');

  const chain = [];
  for (let node = surface.parentElement; node && node !== env.document.body; node = node.parentElement) {
    chain.push(node);
  }
  assert.ok(chain.length > 0, 'the detection surface is attached to the document');
  assert.equal(chain[0], env.viewer.container,
    'the detection surface hangs off the Cesium container that holds the WebGL canvas');

  const isolating = chain
    .filter((node) => formsStackingContext(cssDeclarationsFor(css, `#${node.id}`)))
    .map((node) => node.id);
  assert.deepEqual(isolating, [],
    'an ancestor forming a stacking context would silently discard the screen blend');

  // Negative control: the predicate has teeth. The former parent DOES isolate,
  // so this test would have failed on the regression it exists to catch.
  assert.equal(formsStackingContext(cssDeclarationsFor(css, '#world-overlay-root')), true,
    '#world-overlay-root is a stacking context and must never parent the detection surface');
  // Paint order is carried by z-index alone now that the two surfaces are not
  // siblings: detection z5 under the shared card canvas root at z6.
  assert.equal(cssDeclarationsFor(css, '#world-overlay-detection-surface')['z-index'], '5');
  assert.equal(cssDeclarationsFor(css, '#world-overlay-root')['z-index'], '6');
  env.cleanup();
});

test('canvas backing store tracks CSS size and live DPR', () => {
  const env = installMockEnvironment({ width: 400, height: 300, dpr: 2 });
  initWorldOverlay(env.viewer);
  let canvas = env.document.getElementById('world-overlay-canvas');
  let detectionSurface = env.document.getElementById('world-overlay-detection-surface');
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(detectionSurface.width, 0);
  assert.equal(detectionSurface.height, 0);
  env.viewer.canvas.clientWidth = 500;
  env.viewer.canvas.clientHeight = 200;
  env.window.devicePixelRatio = 1.5;
  env.window.dispatch('resize');
  setOverlayEntries('resize-probe', [selectedEntry('probe')]);
  env.postRender.raise();
  canvas = env.document.getElementById('world-overlay-canvas');
  detectionSurface = env.document.getElementById('world-overlay-detection-surface');
  assert.equal(canvas.width, 750);
  assert.equal(canvas.height, 300);
  assert.equal(detectionSurface.width, 750);
  assert.equal(detectionSurface.height, 300);
  assert.ok(env.ctx.calls.some((call) => call[0] === 'setTransform' && call[1] === 1.5));
  assert.ok(env.detectionCtx.calls.some((call) => call[0] === 'setTransform' && call[1] === 1.5));
  env.cleanup();
});

test('shared fade tuning reaches a host-painted card on the next rendered frame', () => {
  const env = installMockEnvironment({ width: 400, height: 300, dpr: 1 });
  const paintedAlphas = [];
  Object.defineProperty(env.ctx, 'globalAlpha', {
    configurable: true,
    get() { return paintedAlphas.at(-1) ?? 1; },
    set(value) { paintedAlphas.push(value); },
  });
  try {
    setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0.05 });
    initWorldOverlay(env.viewer);
    setOverlayEntries('fade-host', [selectedEntry('CARD', {
      position: new Cesium.Cartesian3(0.85, 0, 0),
      variant: 'card',
      edgeFade: 'keyhole',
      placement: 'above',
    })]);
    env.postRender.raise();
    const firstAlpha = paintedAlphas.at(-1);

    setKeyholeFadeTuning({ fadeRatio: 0.4, outsideOpacity: 0.05 });
    env.postRender.raise();
    const nextAlpha = paintedAlphas.at(-1);

    assert.ok(firstAlpha > 0 && firstAlpha < 1, `expected feathered first alpha, got ${firstAlpha}`);
    assert.ok(nextAlpha > firstAlpha, `${firstAlpha} should change on the next frame, got ${nextAlpha}`);
  } finally {
    setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0.05 });
    env.cleanup();
  }
});

test('inlined host alpha binding matches combinedOverlayAlpha across channel ranges', () => {
  const env = installMockEnvironment({ width: 400, height: 300, dpr: 1 });
  const paintedAlphas = [];
  Object.defineProperty(env.ctx, 'globalAlpha', {
    configurable: true,
    get() { return paintedAlphas.at(-1) ?? 1; },
    set(value) { paintedAlphas.push(value); },
  });
  initWorldOverlay(env.viewer);
  const cases = [
    { source: 1, entry: 0.9, temporal: 0.8, distance: 0.25, altitude: 0.25 },
    { source: 0.8, entry: 0.75, temporal: 0.7, distance: 0.5, altitude: 0.5 },
    { source: 0.5, entry: 0.5, temporal: 0.4, distance: 0.75, altitude: 0.75 },
  ];
  try {
    for (let index = 0; index < cases.length; index++) {
      const channels = cases[index];
      env.viewer.camera.positionCartographic.height = 9500 - channels.altitude * 2000;
      setOverlayEntries('alpha-binding', [{
        id: `alpha-${index}`,
        position: new Cesium.Cartesian3(0, 0, channels.distance * 10_000_000),
        variant: 'label',
        title: 'ALPHA',
        protected: true,
        horizonCull: false,
        edgeFade: 'none',
        sourceAlpha: channels.entry,
        temporalAlpha: channels.temporal,
        maxDistance: 10_000_000,
        distanceFadeStartRatio: 0,
        altitudeFadeStart: 7500,
        altitudeFadeEnd: 9500,
      }], { alpha: channels.source, cohortLimit: 1, collisionCapacity: 0 });
      paintedAlphas.length = 0;
      env.postRender.raise();
      const expected = combinedOverlayAlpha({
        sourceAlpha: channels.source * channels.entry,
        temporalFade: channels.temporal,
        distanceFade: channels.distance,
        altitudeFade: channels.altitude,
        keyholeEdgeFade: 1,
      });
      assert.ok(
        Math.abs(paintedAlphas.at(-1) - expected) < 1e-12,
        `case ${index}: expected ${expected}, painted ${paintedAlphas.at(-1)}`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test('a host dormant since init holds no canvas backing store', () => {
  const env = installMockEnvironment({ width: 1600, height: 900, dpr: 2 });
  initWorldOverlay(env.viewer);
  const canvas = env.document.getElementById('world-overlay-canvas');
  const detectionSurface = env.document.getElementById('world-overlay-detection-surface');
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(detectionSurface.width, 0);
  assert.equal(detectionSurface.height, 0);

  env.window.dispatch('resize');
  for (let frame = 0; frame < 4; frame++) {
    env.advanceTime(120);
    env.postRender.raise();
  }
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(detectionSurface.width, 0);
  assert.equal(detectionSurface.height, 0);

  setOverlayEntries('lazy-canvas', [selectedEntry('first-paint')]);
  env.advanceTime(120);
  env.postRender.raise();
  assert.equal(canvas.width, 3200);
  assert.equal(canvas.height, 1800);
  assert.equal(detectionSurface.width, 3200);
  assert.equal(detectionSurface.height, 1800);
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);

  // Emptying a source that already painted may keep the sized backing store;
  // only the dormant-since-init host is required to stay at 0x0.
  assert.equal(clearOverlaySource('lazy-canvas'), true);
  env.advanceTime(600);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 0);
  env.cleanup();
});

test('empty postRender stays inert through production mutation, resize, and clock noise', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  env.postRender.raise();
  const settledCallCount = env.ctx.calls.length;
  const settledLayoutReads = { ...env.layoutReads };
  for (let frame = 0; frame < 6; frame++) {
    env.advanceTime(250);
    for (const observer of env.mutationObservers) observer.callback();
    for (const observer of env.resizeObservers) observer.callback();
    env.window.dispatch('resize');
    env.postRender.raise();
  }
  assert.equal(env.ctx.calls.length, settledCallCount);
  assert.deepEqual(env.layoutReads, settledLayoutReads);
  assert.equal(getWorldOverlayDiagnostics().entryCount, 0);
  env.cleanup();
});

test('HUD mutations defer occluder selector scans until overlay paint work exists', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  const settledQueries = { ...env.selectorQueries };
  const hudMutation = {
    type: 'childList',
    target: env.document.body,
    addedNodes: [env.document.createElement('div')],
    removedNodes: [],
  };
  for (const observer of env.mutationObservers) observer.callback([hudMutation]);
  assert.deepEqual(env.selectorQueries, settledQueries);

  env.advanceTime(101);
  setOverlayEntries('lazy-occluders', [selectedEntry('paint-work')]);
  env.postRender.raise();
  assert.ok(env.selectorQueries.querySelectorAll > settledQueries.querySelectorAll);
  env.cleanup();
});

test('ticking chrome churn (text swaps, non-chrome nodes) never invalidates a live host', () => {
  const env = installMockEnvironment({
    occluders: [
      { selector: '.hud-top-left', rect: { left: 0, top: 0, width: 140, height: 44 } },
      { id: 'traffic-sync-chip', rect: { left: 200, top: 0, width: 90, height: 24 } },
    ],
  });
  initWorldOverlay(env.viewer);
  setOverlayEntries('ticker-noise', [selectedEntry('live-entry')]);
  env.postRender.raise();

  // A HUD clock tick: `textContent = ...` swaps TEXT nodes deep inside chrome.
  // (Built before the settled counters: the mock's querySelector delegates to
  // querySelectorAll, and this fixture lookup must not pollute the baseline.)
  const textNode = { nodeType: 3 };
  const clockTick = {
    type: 'childList',
    target: env.document.querySelector('.hud-top-left'),
    addedNodes: [textNode],
    removedNodes: [textNode],
  };
  const settledRenders = env.viewer.scene.requestRenderCount;
  const settledScans = env.selectorQueries.querySelectorAll;
  // Element churn that neither is nor contains inventory chrome (stream lines,
  // toast rows, typing spans) anywhere else under body.
  const streamLine = {
    type: 'childList',
    target: env.document.body,
    addedNodes: [env.document.createElement('div')],
    removedNodes: [],
  };
  for (let tick = 0; tick < 25; tick++) {
    for (const observer of env.mutationObservers) observer.callback([clockTick, streamLine]);
  }
  assert.equal(env.viewer.scene.requestRenderCount, settledRenders,
    'ticking chrome must not request renders while the camera is parked');
  env.advanceTime(150);
  env.postRender.raise();
  assert.equal(env.selectorQueries.querySelectorAll, settledScans,
    'ticking chrome must not re-scan the occluder inventory');
  env.cleanup();
});

test('genuine chrome changes still invalidate: add, remove, and own-attribute flips', () => {
  const env = installMockEnvironment({
    occluders: [
      { id: 'pp-toggles', rect: { left: 300, top: 40, width: 60, height: 200 } },
    ],
  });
  initWorldOverlay(env.viewer);
  setOverlayEntries('chrome-changes', [selectedEntry('live-entry')]);
  env.postRender.raise();
  const observer = env.mutationObservers[0];

  // A panel flipping its own class/style/hidden (collapse, drag, show/hide).
  let renders = env.viewer.scene.requestRenderCount;
  observer.callback([{
    type: 'attributes',
    target: env.document.getElementById('pp-toggles'),
    attributeName: 'class',
  }]);
  assert.equal(env.viewer.scene.requestRenderCount, renders + 1, 'own-attribute flip invalidates');

  // Chrome appearing later, nested: an added subtree CONTAINING inventory chrome.
  const wrapper = env.document.createElement('div');
  const awareness = env.document.createElement('div');
  awareness.id = 'military-awareness-panel';
  wrapper.appendChild(awareness);
  renders = env.viewer.scene.requestRenderCount;
  observer.callback([{
    type: 'childList', target: env.document.body, addedNodes: [wrapper], removedNodes: [],
  }]);
  assert.equal(env.viewer.scene.requestRenderCount, renders + 1, 'added chrome invalidates');

  // Chrome disappearing: a removed node that IS inventory chrome.
  renders = env.viewer.scene.requestRenderCount;
  observer.callback([{
    type: 'childList', target: env.document.body, addedNodes: [], removedNodes: [awareness],
  }]);
  assert.equal(env.viewer.scene.requestRenderCount, renders + 1, 'removed chrome invalidates');
  env.cleanup();
});

test('chrome observers scope: body is childList discovery; occluder attributes are element-only', () => {
  const env = installMockEnvironment({
    occluders: [
      { selector: '.hud-top-left', rect: { left: 0, top: 0, width: 140, height: 44 } },
    ],
  });
  initWorldOverlay(env.viewer);
  setOverlayEntries('observer-scope', [selectedEntry('live-entry')]);
  env.postRender.raise();

  // Chrome discovered LATE goes through the refresh-time observe site too.
  const late = env.document.createElement('div');
  late.id = 'military-awareness-panel';
  late._rect = { left: 10, top: 10, width: 100, height: 80 };
  Object.assign(late.style, shippedStacking('#military-awareness-panel'));
  env.document.body.appendChild(late);
  env.mutationObservers[0].callback([{
    type: 'childList', target: env.document.body, addedNodes: [late], removedNodes: [],
  }]);
  env.advanceTime(150);
  env.postRender.raise();

  const observations = env.mutationObservers.flatMap((observer) => observer.observations);
  const bodyObservations = observations.filter(({ target }) => target === env.document.body);
  const chromeObservations = observations.filter(({ target }) => target !== env.document.body);
  assert.equal(bodyObservations.length, 1, 'body is observed exactly once');
  assert.equal(bodyObservations[0].options.childList, true);
  assert.equal(bodyObservations[0].options.subtree, true);
  assert.notEqual(bodyObservations[0].options.attributes, true, 'body carries no attribute churn');
  const chromeTargets = new Set(chromeObservations.map(({ target }) => target));
  assert.ok(chromeTargets.has(late), 'late chrome is attribute-observed after discovery');
  assert.ok(chromeObservations.length >= 2, 'both observe sites covered (init-time and refresh-time)');
  for (const { options } of chromeObservations) {
    assert.equal(options.attributes, true);
    for (const name of ['class', 'style', 'hidden']) {
      assert.ok(options.attributeFilter.includes(name), `attributeFilter carries ${name}`);
    }
    assert.notEqual(options.subtree, true,
      'descendant churn (REC-dot blink, chip internals) must not reach the observer');
  }
  env.cleanup();
});

test('projection records never retain keys for entries that are no longer live', () => {
  const originalSet = Map.prototype.set;
  let recordMap = null;
  Map.prototype.set = function captureProjectionRecordMap(key, value) {
    if (typeof key === 'string' && key.includes('\u0000')
      && value?.key === key && value?.candidate?._record === value) {
      recordMap = this;
    }
    return originalSet.call(this, key, value);
  };

  const env = installMockEnvironment();
  try {
    initWorldOverlay(env.viewer);
    for (let batch = 0; batch < 4; batch++) {
      const entries = Array.from({ length: 320 }, (_, index) => (
        selectedEntry(`batch-${batch}-${index}`, {
          selected: false,
          protected: false,
          collisionGroup: 'churn',
        })
      ));
      const liveKeys = new Set(entries.map((entry) => `churn\u0000${entry.id}`));
      const assertNoStaleKeys = () => {
        for (const key of recordMap.keys()) {
          assert.ok(liveKeys.has(key), `stale projection record: ${key}`);
        }
      };
      setOverlayEntries('churn', entries, { cohortLimit: 8, collisionCapacity: 4 });
      env.postRender.raise();
      assert.ok(recordMap);
      assert.ok(recordMap.size < getWorldOverlayDiagnostics().entryCount);
      assertNoStaleKeys();
      assert.equal(removeOverlayEntry('churn', entries[0].id), true);
      liveKeys.delete(`churn\u0000${entries[0].id}`);
      assertNoStaleKeys();
      assert.equal(clearOverlaySource('churn'), true);
      liveKeys.clear();
      assertNoStaleKeys();
    }
  } finally {
    Map.prototype.set = originalSet;
    env.cleanup();
  }
});

test('the per-domain candidate index stays bounded while identities churn', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  const COHORT = 40;
  const BATCHES = 60;
  const batchEntries = (batch) => Array.from({ length: COHORT }, (_, index) => (
    selectedEntry(`batch-${batch}-${index}`, {
      selected: false,
      protected: false,
      collisionGroup: 'churn',
    })
  ));

  let peakIndexSize = 0;
  for (let batch = 0; batch < BATCHES; batch++) {
    setOverlayEntries('churn', batchEntries(batch), {
      cohortLimit: COHORT,
      collisionCapacity: COHORT,
    });
    env.advanceTime(16);
    env.postRender.raise();
    peakIndexSize = Math.max(peakIndexSize, getWorldOverlayDiagnostics().candidateIndexSize);
  }

  // `resetFrameDomains` prunes at `live * 4 + 64` and the frame then republishes
  // the live cohort, so the index can never exceed that plus one cohort — no
  // matter how many distinct identities passed through it.
  const publishedIdentities = COHORT * BATCHES;
  const bound = COHORT * 4 + 64 + COHORT;
  assert.ok(peakIndexSize > 0, 'the candidate index was never populated');
  assert.ok(
    peakIndexSize <= bound,
    `candidate index grew to ${peakIndexSize} after ${publishedIdentities} identities (bound ${bound})`,
  );
  assert.ok(publishedIdentities > bound * 4, 'churn workload was too small to prove the bound');
  env.cleanup();
});

test('entry normalization validates required fields and source lifecycle is stable', () => {
  const activate = () => true;
  const normalized = normalizeOverlayEntry('fires', {
    id: 'a',
    position: position(),
    title: 42,
    interactive: true,
    accessibilityLabel: 'Focus fire detection 42',
    activate,
  });
  assert.equal(normalized.source, 'fires');
  assert.equal(normalized.variant, 'label');
  assert.equal(normalized.title, '42');
  assert.equal(normalized.edgeFade, 'keyhole');
  assert.equal(normalized.horizonCull, true);
  assert.equal(normalized.accessibilityLabel, 'Focus fire detection 42');
  assert.equal(normalized.activate, activate);
  assert.throws(() => normalizeOverlayEntry('', { id: 'a', position: position() }), /sourceId/);
  assert.throws(() => normalizeOverlayEntry('fires', { id: '', position: position() }), /entry.id/);
  assert.throws(() => normalizeOverlayEntry('fires', { id: 'a', position: null }), /position/);
  assert.throws(() => normalizeOverlayEntry('fires', { id: 'a', position: position(), variant: 'table' }), /variant/);

  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('fires', [normalized]);
  upsertOverlayEntry('fires', { id: 'b', position: position(), variant: 'card' });
  assert.deepEqual(getWorldOverlayDiagnostics().entriesBySource, { fires: 2 });
  assert.equal(removeOverlayEntry('fires', 'a'), true);
  assert.equal(removeOverlayEntry('fires', 'missing'), false);
  setOverlaySourceVisible('fires', false);
  assert.equal(clearOverlaySource('fires'), true);
  assert.deepEqual(getWorldOverlayDiagnostics().entriesBySource, { fires: 0 });
  env.cleanup();
});

test('accessible actions announce only accepted focus and expose selected state', () => {
  const env = installMockEnvironment();
  let acceptedActivations = 0;
  let staleActivations = 0;
  initWorldOverlay(env.viewer);
  setOverlayEntries('accessible-actions', [selectedEntry('vessel:123', {
    interactive: true,
    accessibilityLabel: 'Focus vessel TEST, MMSI 123',
    activate: () => {
      acceptedActivations++;
      return true;
    },
  })]);
  env.postRender.raise();

  const list = env.document.getElementById('world-overlay-action-list');
  const status = env.document.getElementById('world-overlay-status');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]['aria-pressed'], 'true');
  list.children[0].click();
  assert.equal(acceptedActivations, 1);
  assert.equal(status.textContent, 'Focusing Focus vessel TEST, MMSI 123');

  status.textContent = 'Focus unchanged';
  setOverlayEntries('accessible-actions', [selectedEntry('vessel:123', {
    selected: false,
    interactive: true,
    accessibilityLabel: 'Focus vessel TEST, MMSI 123',
    activate: () => {
      staleActivations++;
      return false;
    },
  })]);
  env.postRender.raise();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]['aria-pressed'], 'false');
  list.children[0].click();
  assert.equal(staleActivations, 1);
  assert.equal(status.textContent, 'Focus unchanged');
  env.cleanup();
});

test('viewport and horizon culling obey explicit policy inputs', () => {
  const point = position();
  const hiddenOccluder = { isPointVisible: () => false };
  assert.equal(isOverlayPointVisible(
    { horizonCull: true, viewportPadding: 0 },
    point,
    { x: 50, y: 50 },
    { width: 100, height: 100 },
    hiddenOccluder,
  ), false);
  assert.equal(isOverlayPointVisible(
    { horizonCull: false, viewportPadding: 0 },
    point,
    { x: 50, y: 50 },
    { width: 100, height: 100 },
    hiddenOccluder,
  ), true);
  assert.equal(isOverlayPointVisible(
    { horizonCull: false, viewportPadding: 5 },
    point,
    { x: -6, y: 50 },
    { width: 100, height: 100 },
    hiddenOccluder,
  ), false);
  assert.equal(isOverlayPointVisible(
    { horizonCull: false, viewportPadding: 5 },
    point,
    { x: -5, y: 105 },
    { width: 100, height: 100 },
    hiddenOccluder,
  ), true);
});

test('paint lanes are deterministic across all seven binding lanes', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  assert.deepEqual(WORLD_OVERLAY_PAINT_LANES, [
    'detection',
    'ambient-label',
    'ambient-track',
    'ambient-card',
    'thumbnail',
    'selected',
    'tracked',
  ], 'the exported lane array order is the binding contract');
  const laneEntries = [
    selectedEntry('DETECTION', { variant: 'label', paintLane: 'detection' }),
    selectedEntry('LABEL', { variant: 'label', paintLane: 'ambient-label' }),
    selectedEntry('TRACK', { variant: 'track', paintLane: 'ambient-track' }),
    selectedEntry('CARD', { variant: 'card', paintLane: 'ambient-card' }),
    selectedEntry('THUMBNAIL', { variant: 'thumbnail', paintLane: 'thumbnail' }),
    selectedEntry('SELECTED', { variant: 'selected', paintLane: 'selected' }),
    selectedEntry('TRACKED', { variant: 'tracked', paintLane: 'tracked' }),
  ].reverse();
  setOverlayEntries('lanes', laneEntries);
  env.postRender.raise();
  const textOrder = env.ctx.calls
    .filter(([name]) => name === 'fillText')
    .map(([, value]) => value);
  assert.deepEqual(textOrder.slice(-7), WORLD_OVERLAY_PAINT_LANES.map((lane) => ({
    detection: 'DETECTION',
    'ambient-label': 'LABEL',
    'ambient-track': 'TRACK',
    'ambient-card': 'CARD',
    thumbnail: 'THUMBNAIL',
    selected: 'SELECTED',
    tracked: 'TRACKED',
  })[lane]));
  assert.deepEqual(laneEntries.map(paintLaneForOverlayEntry).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  env.cleanup();
});

test('custom detection lane receives the shared host frame and paints below ordinary entries', () => {
  const env = installMockEnvironment({
    width: 400,
    height: 300,
    dpr: 2,
    occluderRect: { left: 10, top: 20, width: 80, height: 40 },
  });
  initWorldOverlay(env.viewer);
  let capturedFrame = null;
  let paintCount = 0;
  const lane = registerWorldOverlayPaintLane('detection', (frame) => {
    capturedFrame = frame;
    paintCount++;
    frame.ctx.fillText('CUSTOM-DETECTION', 20, 20);
  }, { id: 'detection', active: true, target: 'detection' });
  setOverlayEntries('cards', [selectedEntry('HOST-CARD', {
    variant: 'label',
    paintLane: 'ambient-label',
  })]);

  env.postRender.raise();
  assert.equal(env.postRender.listeners.size, 1, 'the host remains the sole postRender owner');
  assert.equal(capturedFrame.canvas, env.document.getElementById('world-overlay-canvas'));
  assert.equal(capturedFrame.surface, env.document.getElementById('world-overlay-detection-surface'));
  assert.equal(capturedFrame.ctx, env.detectionCtx);
  assert.equal(capturedFrame.width, 400);
  assert.equal(capturedFrame.height, 300);
  assert.equal(capturedFrame.dpr, 2);
  assert.equal(capturedFrame.viewProjectionMatrix[0], 1);
  assert.equal(capturedFrame.viewProjection.m0, 1);
  assert.equal(capturedFrame.cameraPosition, env.viewer.camera.positionWC);
  assert.ok(capturedFrame.occluder);
  assert.equal(capturedFrame.uiRects.length, capturedFrame.uiRectCount);
  assert.ok(capturedFrame.uiRectCount > 0);

  const paintOrder = env.paintTrace
    .filter(([, name, value]) => name === 'fillText'
      && (value === 'CUSTOM-DETECTION' || value === 'HOST-CARD'))
    .map(([, , value]) => value);
  assert.deepEqual(paintOrder, ['CUSTOM-DETECTION', 'HOST-CARD']);
  assert.ok(env.detectionCtx.calls.some(([name]) => name === 'clearRect'),
    'the host clear routine clears the detection target before paint');

  // Phase-6 keyhole parity probe: the host-supplied geometry evaluates to the
  // exact legacy helper result at the center, all four edges, and two corners.
  const legacy = getKeyholeGeometry(400, 300);
  const points = [
    [200, 150], [0, 150], [400, 150], [200, 0], [200, 300], [0, 0], [400, 300],
  ];
  assert.deepEqual(
    points.map(([x, y]) => keyholeLabelAlphaFromGeometry(x, y, capturedFrame.keyhole)),
    points.map(([x, y]) => keyholeLabelAlphaFromGeometry(x, y, legacy)),
  );

  lane.setActive(false);
  env.postRender.raise();
  assert.equal(paintCount, 1);
  destroyWorldOverlay();
  lane.setActive(true);
  lane.requestPaint();
  assert.equal(env.document.getElementById('world-overlay-canvas'), null);
  assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  assert.equal(env.postRender.listeners.size, 0);
  env.cleanup();
});

test('custom-lane painter state is bracketed by host save/restore', () => {
  // A painter that leaks a clip or alpha must not corrupt later frames: the
  // host wraps every custom-lane painter in save/try/finally-restore. Pin the
  // bracketing structurally (the mock ctx records call order, not state).
  const env = installMockEnvironment({ width: 400, height: 300, dpr: 1 });
  initWorldOverlay(env.viewer);
  const lane = registerWorldOverlayPaintLane('detection', (frame) => {
    frame.ctx.beginPath();
    frame.ctx.rect(0, 0, 1, 1);
    frame.ctx.clip();
    frame.ctx.fillText('H5-MARKER', 1, 1);
  }, { id: 'detection', active: true, target: 'detection' });
  env.postRender.raise();
  const calls = env.detectionCtx.calls;
  const marker = calls.findIndex(([name, text]) => name === 'fillText' && text === 'H5-MARKER');
  assert.ok(marker >= 0, 'custom painter ran against the detection target');
  const saveBefore = calls.slice(0, marker).map(([name]) => name).lastIndexOf('save');
  assert.ok(saveBefore >= 0, 'host saves ctx state before invoking the painter');
  assert.ok(
    !calls.slice(saveBefore + 1, marker).some(([name]) => name === 'restore'),
    'the save bracketing the painter is still open when the painter runs',
  );
  assert.ok(
    calls.slice(marker + 1).some(([name]) => name === 'restore'),
    'host restores ctx state after the painter returns',
  );
  lane.unregister();
  env.cleanup();
});

test('custom lanes without the detection target paint on the shared canvas', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  let target = null;
  registerWorldOverlayPaintLane('ambient-label', (frame) => {
    target = { surface: frame.surface, ctx: frame.ctx };
  }, { id: 'shared-custom', active: true });
  env.postRender.raise();
  assert.equal(target.surface, env.document.getElementById('world-overlay-canvas'));
  assert.equal(target.ctx, env.ctx);
  env.cleanup();
});

// ── UI exclusion contract ───────────────────────────────────────────────────
// These replace a single earlier test that fed a FULL-VIEWPORT occluder and
// asserted `paintedCount === 0` plus a `clip('evenodd')` call. That contract
// pinned the defect as correct: it is exactly the cockpit failure mode (the
// coalesced chrome union reached 94-98 % of the viewport, deleting every card
// and clipping detection to nothing), and it blessed the even-odd clip that
// punched hard-edged voids through the detection field in map view. The
// exclusion inventory is now a per-rect PLACEMENT PREFERENCE over visible
// chrome only, and it clips nothing.

/** Screen-space (x, y) -> the world position that projects there in the mock. */
function positionAtScreen(x, y, width = 400, height = 300) {
  return new Cesium.Cartesian3((x / (width / 2)) - 1, 1 - (y / (height / 2)), 0);
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function inflatedRect({ left, top, width, height }, padding = 6) {
  return { x: left - padding, y: top - padding, w: width + padding * 2, h: height + padding * 2 };
}

test('UI exclusions stay per-rect: overlapping chrome never merges into a bounding union', () => {
  // Two overlapping panels. Their transitive bounding UNION would sweep almost
  // the whole viewport, including a large region neither panel occupies — that
  // union is what produced the moving oversized voids and the size jumps as
  // panels expanded. An entry anchored in that empty region must be unaffected.
  const chrome = {
    left: { left: 0, top: 0, width: 60, height: 220 },
    bottom: { left: 40, top: 200, width: 200, height: 60 },
  };
  const env = installMockEnvironment({
    width: 400,
    height: 300,
    dpr: 1,
    occluders: [
      { id: 'left-panel-stack', rect: chrome.left },
      { id: 'command-dock', rect: chrome.bottom },
    ],
  });
  initWorldOverlay(env.viewer);
  let uiRects = null;
  registerWorldOverlayPaintLane('detection', (frame) => {
    uiRects = frame.uiRects.slice(0, frame.uiRectCount)
      .map(({ x, y, w, h }) => ({ x, y, w, h }));
  }, { id: 'detection', active: true, target: 'detection' });
  // Anchored just clear of the left panel, close enough that its default
  // above-the-anchor placement would collide with it.
  setOverlayEntries('ambient', [selectedEntry('CLEAR-OF-BOTH', {
    position: positionAtScreen(80, 100),
  })]);
  env.postRender.raise();

  // Mechanism: two elements, two rectangles, each its own inflated box.
  assert.deepEqual(uiRects, [
    { x: -6, y: -6, w: 72, h: 232 },
    { x: 34, y: 194, w: 212, h: 72 },
  ], 'each occluder keeps its own rectangle');

  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  const painted = getOverlayPaintRect('ambient', 'CLEAR-OF-BOTH');
  assert.ok(painted, 'the entry published a paint rectangle');
  for (const [name, rect] of Object.entries(chrome)) {
    assert.equal(rectsIntersect(painted, inflatedRect(rect)), false,
      `the chosen placement steps clear of the ${name} panel`);
  }
  // The two inflated rects overlap, so the old coalescer merged them into one
  // box spanning x -6..246, y -6..266. Inside that union NO placement is clear,
  // so the card would have fallen back to its colliding default — which is why
  // asserting the card sits inside the union keeps this test honest.
  assert.equal(rectsIntersect(painted, { x: -6, y: -6, w: 252, h: 272 }), true,
    'the card sits inside the union the old coalescer would have produced');
  env.cleanup();
});

test('UI exclusions ignore chrome the user cannot see', () => {
  const env = installMockEnvironment({
    width: 400,
    height: 300,
    dpr: 1,
    occluders: [
      { id: 'left-panel-stack', rect: { left: 0, top: 0, width: 400, height: 300 }, hidden: true },
      {
        id: 'command-dock',
        rect: { left: 0, top: 0, width: 400, height: 300 },
        style: { display: 'none' },
      },
      {
        id: 'right-context-rail',
        rect: { left: 0, top: 0, width: 400, height: 300 },
        style: { visibility: 'hidden' },
      },
      { id: 'pp-toggles', rect: { left: 0, top: 0, width: 0, height: 0 } },
    ],
  });
  initWorldOverlay(env.viewer);
  let uiRectCount = -1;
  registerWorldOverlayPaintLane('detection', (frame) => { uiRectCount = frame.uiRectCount; }, {
    id: 'detection',
    active: true,
    target: 'detection',
  });
  setOverlayEntries('ambient', [selectedEntry('VISIBLE-WORLD')]);
  env.postRender.raise();
  assert.equal(uiRectCount, 0,
    'hidden, display:none, visibility:hidden and collapsed chrome contribute nothing',
  );
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  env.cleanup();
});

test('chrome that fills the viewport suppresses neither cards nor the detection lane', () => {
  // The former contract asserted the opposite (paintedCount === 0). No
  // exclusion set may ever delete the whole world: when no placement is clear,
  // the entry keeps its variants and renders beneath chrome that already
  // composites above this host.
  const env = installMockEnvironment({
    width: 400,
    height: 300,
    dpr: 1,
    occluderRect: { left: 0, top: 0, width: 400, height: 300 },
  });
  initWorldOverlay(env.viewer);
  let detectionPaints = 0;
  registerWorldOverlayPaintLane('detection', (frame) => {
    detectionPaints++;
    frame.ctx.fillText('DETECTION-ALIVE', 10, 10);
  }, { id: 'detection', active: true, target: 'detection' });
  setOverlayEntries('blocked', [selectedEntry('behind-ui')]);
  env.postRender.raise();

  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1,
    'the card survives a viewport-filling exclusion instead of being deleted');
  assert.equal(detectionPaints, 1);
  assert.ok(
    env.detectionCtx.calls.some(([name, text]) => name === 'fillText' && text === 'DETECTION-ALIVE'),
    'detection paints its full field',
  );
  for (const [surface, calls] of [['shared', env.ctx.calls], ['detection', env.detectionCtx.calls]]) {
    assert.equal(calls.some(([name]) => name === 'clip'), false,
      `the host applies no UI clip to the ${surface} surface`);
  }
  env.cleanup();
});

test('a placement is only ever kept under chrome that composites ABOVE the host', () => {
  // The soft-preference fallback is justified by "the chrome paints over the
  // card anyway". That is true of map panels (z90+) and false of #intel-hud,
  // which the shipped stylesheet puts at z2 — BELOW both host surfaces (z5/z6).
  // A card kept under a HUD corner would render ON TOP of its text, breaking the
  // absolute rule that labels never cover the UI. Read from the real stylesheet,
  // so a z-index change in style.css moves this test rather than fooling it.
  const hostTopZ = Number(cssDeclarationsFor(SHIPPED_CSS, '#world-overlay-root')['z-index']);
  const hudZ = Number(cssDeclarationsFor(SHIPPED_CSS, '#intel-hud')['z-index']);
  const panelZ = Number(cssDeclarationsFor(SHIPPED_CSS, '#left-panel-stack')['z-index']);
  assert.ok(Number.isFinite(hostTopZ) && Number.isFinite(hudZ) && Number.isFinite(panelZ));
  assert.ok(hudZ < hostTopZ, `#intel-hud (${hudZ}) must stack below the host (${hostTopZ})`);
  assert.ok(panelZ > hostTopZ, `#left-panel-stack (${panelZ}) must stack above the host`);

  const paintedUnder = (occluders) => {
    const env = installMockEnvironment({ width: 400, height: 300, dpr: 1, occluders });
    initWorldOverlay(env.viewer);
    setOverlayEntries('ambient', [selectedEntry('CONTACT')]);
    env.postRender.raise();
    const { paintedCount } = getWorldOverlayDiagnostics();
    env.cleanup();
    return paintedCount;
  };

  const viewport = { left: 0, top: 0, width: 400, height: 300 };
  // Above the host: unplaceable is still safe, so the card is kept and the panel
  // simply covers it — the behaviour that fixed the cockpit blackout.
  assert.equal(paintedUnder([{ id: 'left-panel-stack', rect: viewport }]), 1,
    'chrome above the host keeps the soft preference');
  // Below the host: no placement may overlap it, so the entry is vetoed instead
  // of painting over HUD text. `.hud-top-left` is nested in #intel-hud, so this
  // also proves the classifier walks the ancestor chain rather than reading the
  // element's own (auto) z-index.
  assert.equal(paintedUnder([{ selector: '.hud-top-left', parent: '#intel-hud', rect: viewport }]), 0,
    'chrome below the host keeps an absolute veto');
});

test('cockpit keeps its cards and its detection lane, and hides only the tracked readout', () => {
  // Cockpit-shaped fixture: the two solid cockpit windows at their shipped
  // bounded geometry (min(340px, 28vw) wide, min(42vh, 410px) tall), bottom
  // left and bottom right. Previously the twelve cockpit selectors coalesced
  // into one near-fullscreen rectangle that took every card and all of
  // Panoptic with it.
  const env = installMockEnvironment({
    width: 400,
    height: 300,
    dpr: 1,
    occluders: [
      { id: 'cockpit-context', rect: { left: 12, top: 174, width: 112, height: 114 } },
      { id: 'cockpit-signal-stream', rect: { left: 276, top: 174, width: 112, height: 114 } },
      // The dropped line art, at the geometry that used to swallow the screen:
      // a viewport-wide topline and a keyhole-tall rim on each side. Present in
      // the DOM, absent from the inventory, therefore inert. Under the old
      // 12-selector list these three coalesced with everything else into one
      // near-fullscreen rectangle.
      { selector: '.cockpit-topline', inInventory: false, rect: { left: 13, top: 4, width: 374, height: 26 } },
      { selector: '.cockpit-altitude-rim', inInventory: false, rect: { left: 253, top: 0, width: 57, height: 299 } },
      { selector: '.cockpit-roll-arc', inInventory: false, rect: { left: 88, top: 2, width: 224, height: 32 } },
    ],
  });
  initWorldOverlay(env.viewer);
  let uiRectCount = -1;
  let detectionPaints = 0;
  registerWorldOverlayPaintLane('detection', (frame) => {
    detectionPaints++;
    uiRectCount = frame.uiRectCount;
  }, {
    id: 'detection',
    active: true,
    target: 'detection',
  });
  setOverlayEntries('vessels', [
    selectedEntry('VESSEL-A', { position: positionAtScreen(200, 90) }),
    selectedEntry('VESSEL-B', { position: positionAtScreen(120, 130) }),
  ]);
  setOverlayEntries('trackedReadout', [selectedEntry('TRACKED')], { hideInCockpit: true });

  env.window.dispatch('gev:cockpit-mode-changed', { detail: { active: true } });
  env.postRender.raise();

  assert.equal(getWorldOverlayDiagnostics().paintedCount, 2,
    'both ambient cards survive cockpit entry');
  assert.ok(getOverlayPaintRect('vessels', 'VESSEL-A'));
  assert.ok(getOverlayPaintRect('vessels', 'VESSEL-B'));
  assert.equal(getOverlayPaintRect('trackedReadout', 'TRACKED'), null,
    'the source-level hideInCockpit rule still hides the tracked readout');
  assert.equal(detectionPaints, 1, 'Panoptic keeps painting in cockpit');
  assert.equal(uiRectCount, 2,
    'only the two solid cockpit windows exclude; the line art contributes nothing');
  env.cleanup();
});

test('opt-in anchor separation thins a co-located cohort before the arbiter sees it', () => {
  // Rectangle overlap alone is not the shipped CCTV density: the leader gap does
  // not shrink with the card, so stacked thumbnails clear each other's rects at
  // anchor spacings the shipped anchor-separation pass rejected — about twice the
  // card count down a dense corridor ("card soup").
  //
  // The pass runs at candidate collection, BEFORE selection, which is where the
  // shipped code filtered too. Rejecting inside the arbiter instead leaves the
  // source's quota permanently unfillable, so it rebuilds its spatial queue every
  // solve and breaks the per-frame allocation budget. `projectedCount` is
  // therefore the exact observable.
  const anchors = [500, 540, 580, 620, 660, 700];
  const project = (separation) => {
    const env = installMockEnvironment({ width: 400, height: 800, dpr: 1 });
    initWorldOverlay(env.viewer);
    setOverlayEntries('cctv', anchors.map((y, index) => selectedEntry(`cam-${index}`, {
      position: positionAtScreen(200, y, 400, 800),
      protected: false,
      selected: false,
      priority: 100 - index,
      collisionGroup: 'ambient-card',
      minAnchorSeparationPx: separation,
    })), { collisionCapacity: 16, cohortLimit: 16 });
    env.postRender.raise();
    const { projectedCount } = getWorldOverlayDiagnostics();
    env.cleanup();
    return projectedCount;
  };

  assert.equal(project(0), anchors.length, 'without separation every anchor is a candidate');
  // 40 px apart against a 112 px requirement: the greedy accept keeps the first
  // anchor and then the next one at least 112 px away (500, then 620).
  assert.equal(project(112), 2, 'separation keeps only anchors at least 112 px apart');
  assert.ok(project(112) > 0, 'separation thins the cohort without emptying it');
});

test('the occluder inventory carries no cockpit line-art chrome', () => {
  // Source-level disposition pin. Cockpit chrome renders ABOVE the overlay
  // (#cockpit-hud is z145 against this host's z5/z6), so under the AR-HUD model
  // world content simply passes beneath it. The rim/topline/arc/rail elements
  // are also viewport-scale, which is what made them catastrophic as
  // exclusions. Only the two solid backdrop-filled windows may remain.
  const cockpitSelectors = WORLD_OVERLAY_OCCLUDER_SELECTORS
    .filter((selector) => selector.includes('cockpit'));
  assert.deepEqual(cockpitSelectors, ['#cockpit-context', '#cockpit-signal-stream']);
  for (const selector of WORLD_OVERLAY_OCCLUDER_SELECTORS) {
    assert.equal(selector.startsWith('.cockpit-'), false,
      `${selector} is cockpit line art and must not exclude anything`);
  }
});

test('position getters snapshot once per frame and cockpit-gated sources disappear', () => {
  const env = installMockEnvironment();
  let getterCalls = 0;
  initWorldOverlay(env.viewer);
  setOverlayEntries('tracked', [selectedEntry('flight', {
    position: () => { getterCalls++; return position(); },
    interactive: true,
  })], { hideInCockpit: true });
  env.postRender.raise();
  assert.equal(getterCalls, 1);
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  env.postRender.raise();
  assert.equal(getterCalls, 2);
  env.window.dispatch('gev:cockpit-mode-changed', { detail: { active: true } });
  env.postRender.raise();
  assert.equal(getterCalls, 2);
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 0);
  assert.equal(hitTestWorldOverlay(200, 120), null);
  env.cleanup();
});

test('bounded per-source cohorts feed the domain arbiter without universal selection', () => {
  const normalized = Array.from({ length: 10 }, (_, index) => normalizeOverlayEntry('bulk', {
    id: `item-${index}`,
    position: position(),
    priority: index,
  }));
  const bounded = selectBoundedOverlayCohort(normalized, 3);
  assert.equal(bounded.length, 3);
  assert.deepEqual(bounded.map((entry) => entry.priority).sort((a, b) => b - a), [9, 8, 7]);
  const protectedEntry = normalizeOverlayEntry('bulk', {
    id: 'selected',
    position: position(),
    selected: true,
    priority: -1,
  });
  assert.equal(selectBoundedOverlayCohort([...normalized, protectedEntry], 3).length, 4);

  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('bulk', normalized, { cohortLimit: 3, collisionCapacity: 2 });
  env.postRender.raise();
  const diagnostics = getWorldOverlayDiagnostics();
  assert.equal(diagnostics.entryCount, 10);
  assert.equal(diagnostics.candidateCount, 3);
  assert.ok(diagnostics.selectedCount <= 2);
  env.cleanup();
});

test('FIRMS and vessels enlarge the ambient-card lane under an explicit aggregate budget', () => {
  const env = installMockEnvironment({ width: 1600, height: 900, dpr: 1 });
  initWorldOverlay(env.viewer);
  const makeEntries = (sourceOffset, count = 200) => Array.from({ length: count }, (_, index) => {
    const slot = index % 160;
    const column = slot % 16;
    const row = Math.floor(slot / 16);
    return {
      id: `${sourceOffset}-${index}`,
      position: new Cesium.Cartesian3(
        -0.9 + column * (1.8 / 15),
        0.82 - row * (1.64 / 9),
        0,
      ),
      variant: 'card',
      title: 'X',
      selected: false,
      protected: false,
      horizonCull: false,
      edgeFade: 'none',
      collisionGroup: 'ambient-card',
    };
  });
  setOverlayEntries('local-datacenters', makeEntries('dc'), {
    cohortLimit: 160,
    collisionCapacity: 96,
  });
  setOverlayEntries('local-dams', makeEntries('dam'), {
    cohortLimit: 160,
    collisionCapacity: 96,
  });
  setOverlayEntries('firms', makeEntries('fire').slice(0, 18), {
    cohortLimit: 18,
    collisionCapacity: 18,
  });
  setOverlayEntries('ais-live-vessels', makeEntries('vessel', 900), {
    cohortLimit: 900,
    collisionCapacity: 900,
  });
  setOverlayEntries('cctv', makeEntries('cctv', 40), {
    cohortLimit: 40,
    collisionCapacity: 40,
  });
  env.postRender.raise();
  env.advanceTime(200);
  env.postRender.raise();
  const diagnostics = getWorldOverlayDiagnostics();
  assert.equal(diagnostics.candidateCount, 1278, 'the complete configured cohorts join one bounded domain');
  assert.ok(diagnostics.selectedCount > 96, 'the second source must enlarge the shared lane budget');
  assert.equal(AMBIENT_CARD_COLLISION_CAPACITY, 1150);
  assert.ok(
    diagnostics.selectedCount <= AMBIENT_CARD_COLLISION_CAPACITY,
    'the ambient-card lane must remain globally bounded',
  );
  env.cleanup();
});

test('paint rectangles publish from a pool and topmost interactive lookup wins', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('hits', [
    selectedEntry('under', { interactive: true, zIndex: 1, collisionGroup: 'under' }),
    selectedEntry('over', { interactive: true, zIndex: 2, collisionGroup: 'over' }),
  ]);
  env.postRender.raise();
  const under = getOverlayPaintRect('hits', 'under');
  const over = getOverlayPaintRect('hits', 'over');
  assert.ok(under && over);
  assert.ok(under.x < over.x + over.w && under.x + under.w > over.x);
  assert.ok(under.y < over.y + over.h && under.y + under.h > over.y);
  assert.deepEqual(
    env.ctx.calls.filter(([name]) => name === 'fillText').map(([, title]) => title).slice(-2),
    ['under', 'over'],
    'higher-z entry is the last painted card',
  );
  const hit = hitTestWorldOverlay(200, 120);
  assert.equal(hit.entryId, 'over', 'hit test walks painted entries from last to first');
  assert.equal(hit.sourceId, 'hits');
  assert.equal(getWorldOverlayDiagnostics().hitRectCount, 2);
  env.cleanup();
});

test('CCTV stable frame slots gate ambient chrome and wire the exact host hit rectangle', () => {
  const env = installMockEnvironment({ width: 500, height: 400, dpr: 1 });
  initWorldOverlay(env.viewer);
  const slot = createFrameSlot();
  const entry = createCctvThumbnailOverlayEntry({
    id: 'cam-a',
    position: position(),
    title: 'Main & Fifth',
    frameSlot: slot,
  });
  entry.horizonCull = false;
  entry.maxDistance = Number.POSITIVE_INFINITY;
  setOverlayEntries('cctv', [entry], {
    cohortLimit: 40,
    collisionCapacity: 40,
    moving: true,
    solveIntervalMs: 125,
  });
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 0, 'no ambient placeholder before frame one');
  assert.equal(hitTestWorldOverlay(250, 150, { sourceId: 'cctv' }), null);

  const firstFrame = { name: 'frame-one' };
  slot.frame = firstFrame;
  slot.stamp = 1;
  env.advanceTime(130);
  env.postRender.raise();
  env.advanceTime(16);
  env.postRender.raise();
  const rect = getOverlayPaintRect('cctv', 'cam-a');
  assert.ok(rect);
  assert.deepEqual({ w: rect.w, h: rect.h }, { w: 104, h: 77 });
  const hit = hitTestWorldOverlay(rect.x + 1, rect.y + 1, { sourceId: 'cctv' });
  assert.equal(hit?.entryId, 'cam-a');
  assert.equal(hit?.entry.interactive, true);
  assert.ok(env.ctx.calls.some((call) => call[0] === 'drawImage' && call[1] === firstFrame));

  const secondFrame = { name: 'frame-two' };
  slot.frame = secondFrame;
  slot.stamp = 2;
  env.advanceTime(16);
  env.postRender.raise();
  assert.ok(
    env.ctx.calls.some((call) => call[0] === 'drawImage' && call[1] === secondFrame),
    'slot mutation reaches paint without republishing the entry',
  );
  env.cleanup();
});

test('pinned CCTV chrome may paint before frame one while ordinary safe-top policy still yields', () => {
  const env = installMockEnvironment({ width: 500, height: 400, dpr: 1 });
  initWorldOverlay(env.viewer);
  const ambient = createCctvThumbnailOverlayEntry({
    id: 'ambient-top',
    position: new Cesium.Cartesian3(0, 0.9, 0),
    title: 'AMBIENT',
    frameSlot: { frame: { id: 'ready' }, stamp: 1 },
  });
  ambient.horizonCull = false;
  ambient.maxDistance = Number.POSITIVE_INFINITY;
  const pinned = createCctvThumbnailOverlayEntry({
    id: 'pinned-top',
    position: new Cesium.Cartesian3(0.5, 0.9, 0),
    title: 'PINNED',
    frameSlot: createFrameSlot(),
    pinned: true,
  });
  pinned.horizonCull = false;
  pinned.maxDistance = Number.POSITIVE_INFINITY;
  setOverlayEntries('cctv', [ambient, pinned], { cohortLimit: 40, collisionCapacity: 40 });
  env.postRender.raise();
  assert.equal(getOverlayPaintRect('cctv', 'ambient-top'), null, 'ambient anchor yields to top HUD band');
  assert.ok(getOverlayPaintRect('cctv', 'pinned-top'), 'explicit hover pin paints chrome immediately');
  env.cleanup();
});

test('safe-top yield culls an uncontested ambient entry at projection, with a below-band control', () => {
  // Non-vacuous form of the yield guard: the entry above the band has no
  // pinned neighbor to arbiter-collide with, so only the projection gate can
  // null it; the below-band twin proves the paint path itself is live.
  const env = installMockEnvironment({ width: 500, height: 400, dpr: 1 });
  initWorldOverlay(env.viewer);
  const above = createCctvThumbnailOverlayEntry({
    id: 'yield-above',
    position: new Cesium.Cartesian3(-0.5, 0.9, 0),
    title: 'ABOVE',
    frameSlot: { frame: { id: 'ready' }, stamp: 1 },
  });
  above.horizonCull = false;
  above.maxDistance = Number.POSITIVE_INFINITY;
  const below = createCctvThumbnailOverlayEntry({
    id: 'yield-below',
    position: new Cesium.Cartesian3(0.5, 0, 0),
    title: 'BELOW',
    frameSlot: { frame: { id: 'ready' }, stamp: 1 },
  });
  below.horizonCull = false;
  below.maxDistance = Number.POSITIVE_INFINITY;
  setOverlayEntries('cctv', [above, below], { cohortLimit: 40, collisionCapacity: 40 });
  env.postRender.raise();
  env.advanceTime(130);
  env.postRender.raise();
  env.advanceTime(16);
  env.postRender.raise();
  const diagnostics = getWorldOverlayDiagnostics();
  assert.equal(diagnostics.projectedCount, 1, 'the above-band anchor is culled at projection, not by collision');
  assert.equal(getOverlayPaintRect('cctv', 'yield-above'), null, 'anchor above the HUD safe band must yield');
  assert.ok(getOverlayPaintRect('cctv', 'yield-below'), 'below-band control paints (guard is non-vacuous)');
  env.cleanup();
});

test('CCTV host binding preserves the smoothstep scale and 0.45/0.35 fade curve', () => {
  const env = installMockEnvironment({ width: 500, height: 400, dpr: 1 });
  const paintedAlphas = [];
  Object.defineProperty(env.ctx, 'globalAlpha', {
    configurable: true,
    get() { return paintedAlphas.at(-1) ?? 1; },
    set(value) { paintedAlphas.push(value); },
  });
  initWorldOverlay(env.viewer);
  const entry = createCctvThumbnailOverlayEntry({
    id: 'altitude-curve',
    position: position(),
    title: 'ALTITUDE',
    frameSlot: { frame: { ready: true }, stamp: 1 },
    active: true,
  });
  entry.horizonCull = false;
  entry.maxDistance = Number.POSITIVE_INFINITY;
  entry.edgeFade = 'none';
  assert.deepEqual(entry.altitudeScale, {
    fullEnd: 1800,
    midEnd: 6000,
    end: 9500,
    midValue: 0.45,
    endValue: 0.35,
    smoothToMid: true,
  });
  setOverlayEntries('cctv-altitude', [entry], { cohortLimit: 1, collisionCapacity: 0 });

  const cases = [
    { altitude: 2850, scale: 0.9140625, alpha: 1 },
    { altitude: 6000, scale: 0.45, alpha: 1 },
    { altitude: 9490, scale: 0.35028571428571426, alpha: 0.005 },
  ];
  try {
    for (const expected of cases) {
      env.viewer.camera.positionCartographic.height = expected.altitude;
      env.ctx.calls.length = 0;
      paintedAlphas.length = 0;
      env.postRender.raise();
      const scaleCall = env.ctx.calls.find(([name]) => name === 'scale');
      assert.ok(scaleCall, `altitude ${expected.altitude} should paint in scaled space`);
      assert.ok(Math.abs(scaleCall[1] - expected.scale) < 1e-12);
      assert.ok(Math.abs(scaleCall[2] - expected.scale) < 1e-12);
      assert.ok(Math.abs(paintedAlphas.at(-1) - expected.alpha) < 1e-12);
    }
  } finally {
    env.cleanup();
  }
});

test('CCTV leader remains one CSS pixel at the 0.35 altitude scale point', () => {
  const env = installMockEnvironment({ width: 500, height: 400, dpr: 1 });
  env.viewer.camera.positionCartographic.height = 9500;
  initWorldOverlay(env.viewer);
  const entry = createCctvThumbnailOverlayEntry({
    id: 'scaled-leader',
    position: position(),
    title: 'SCALED',
    frameSlot: { frame: { ready: true }, stamp: 1 },
    active: true,
  });
  entry.horizonCull = false;
  entry.maxDistance = Number.POSITIVE_INFINITY;
  entry.edgeFade = 'none';
  entry.altitudeFadeStart = Number.POSITIVE_INFINITY;
  entry.altitudeFadeEnd = Number.POSITIVE_INFINITY;
  setOverlayEntries('cctv-scaled-leader', [entry], { cohortLimit: 1, collisionCapacity: 0 });
  env.postRender.raise();

  const scale = env.ctx.calls.find(([name]) => name === 'scale')?.[1];
  const canvasLineWidth = env.ctx.calls.find(([name]) => name === 'lineWidth')?.[1];
  assert.ok(Math.abs(scale - 0.35) < 1e-12);
  assert.ok(Math.abs(canvasLineWidth - (1 / 0.35)) < 1e-12);
  assert.ok(Math.abs(scale * canvasLineWidth - 1) < 1e-12, 'painted leader is one CSS pixel');
  env.cleanup();
});

test('active CCTV thumbnail is protected outside the ambient quota and excludes ambient footprint', () => {
  const env = installMockEnvironment({ width: 800, height: 600, dpr: 1 });
  initWorldOverlay(env.viewer);
  const readySlot = () => ({ frame: { ready: true }, stamp: 1 });
  const active = createCctvThumbnailOverlayEntry({
    id: 'active',
    position: position(),
    title: 'ACTIVE',
    frameSlot: readySlot(),
    active: true,
  });
  active.horizonCull = false;
  active.maxDistance = Number.POSITIVE_INFINITY;
  const ambient = createCctvThumbnailOverlayEntry({
    id: 'ambient',
    position: position(),
    title: 'AMBIENT',
    frameSlot: readySlot(),
  });
  ambient.horizonCull = false;
  ambient.maxDistance = Number.POSITIVE_INFINITY;
  setOverlayEntries('cctv-active', [active], { cohortLimit: 1, collisionCapacity: 0 });
  setOverlayEntries('cctv-ambient', [ambient], { cohortLimit: 1, collisionCapacity: 1 });
  env.postRender.raise();
  const activeRect = getOverlayPaintRect('cctv-active', 'active');
  const ambientRect = getOverlayPaintRect('cctv-ambient', 'ambient');
  assert.ok(activeRect, 'active card bypasses a zero ambient quota');
  if (ambientRect) {
    const intersects = ambientRect.x < activeRect.x + activeRect.w
      && ambientRect.x + ambientRect.w > activeRect.x
      && ambientRect.y < activeRect.y + activeRect.h
      && ambientRect.y + ambientRect.h > activeRect.y;
    assert.equal(intersects, false, 'ambient placement yields to the active protected footprint');
  }
  env.cleanup();
});

test('protected tracked entry bypasses ambient quota and excludes its paint footprint', () => {
  const env = installMockEnvironment({ width: 800, height: 600, dpr: 1 });
  initWorldOverlay(env.viewer);
  const position = new Cesium.Cartesian3(0, 0, 0);
  setOverlayEntries('ambient-source', [{
    id: 'ambient',
    position,
    variant: 'card',
    title: 'AMBIENT',
    details: ['CARD'],
    collisionGroup: 'ambient-card',
    verticalOnly: true,
    horizonCull: false,
    edgeFade: 'none',
  }], { cohortLimit: 1, collisionCapacity: 1 });
  setOverlayEntries('tracked', [{
    id: 'flights:test',
    position,
    variant: 'tracked',
    tracked: true,
    protected: true,
    paintLane: 'tracked',
    title: 'TRACKED',
    details: ['FL350'],
    collisionGroup: 'ambient-card',
    verticalOnly: true,
    horizonCull: false,
    edgeFade: 'none',
  }], { cohortLimit: 1, collisionCapacity: 0 });
  env.postRender.raise();
  const trackedRect = getOverlayPaintRect('tracked', 'flights:test');
  const ambientRect = getOverlayPaintRect('ambient-source', 'ambient');
  assert.ok(trackedRect, 'protected tracked card paints with a zero ambient quota');
  if (ambientRect) {
    const intersects = ambientRect.x < trackedRect.x + trackedRect.w
      && ambientRect.x + ambientRect.w > trackedRect.x
      && ambientRect.y < trackedRect.y + trackedRect.h
      && ambientRect.y + ambientRect.h > trackedRect.y;
    assert.equal(intersects, false, 'ambient placement avoids the protected tracked rectangle');
  }
  env.cleanup();
});

test('three clustered protected cards fall back to the least-overlapping placement', () => {
  const env = installMockEnvironment({ width: 800, height: 600, dpr: 1 });
  initWorldOverlay(env.viewer);
  const anchor = new Cesium.Cartesian3(0, 0, 0);
  setOverlayEntries('protected-cluster', [
    selectedEntry('wide-first', {
      position: anchor,
      title: 'WIDE FIRST PROTECTED CARD',
      priority: 3,
      collisionGroup: 'protected-cluster',
      verticalOnly: true,
    }),
    selectedEntry('short-second', {
      position: anchor,
      title: 'S',
      priority: 2,
      collisionGroup: 'protected-cluster',
      verticalOnly: true,
    }),
    selectedEntry('medium-third', {
      position: anchor,
      title: 'MEDIUM THIRD',
      priority: 1,
      collisionGroup: 'protected-cluster',
      verticalOnly: true,
    }),
  ], { cohortLimit: 3, collisionCapacity: 0 });
  env.postRender.raise();

  const first = getOverlayPaintRect('protected-cluster', 'wide-first');
  const second = getOverlayPaintRect('protected-cluster', 'short-second');
  const third = getOverlayPaintRect('protected-cluster', 'medium-third');
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  assert.ok(first && second && third);
  assert.equal(overlapArea(first, second), 0, 'the two-entry separation remains intact');
  assert.equal(overlapArea(first, third), 0, 'the third card no longer stacks on placements[0]');
  assert.ok(overlapArea(second, third) < third.w * third.h, 'fallback minimizes overlap area');
  env.cleanup();
});

test('steady frames reuse paint-item and paint-rectangle pool identities', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('pool-reuse', [selectedEntry('ambient', {
    selected: false,
    protected: false,
    collisionGroup: 'pool-reuse',
  })]);
  env.postRender.raise();
  env.advanceTime(200);
  env.postRender.raise();
  const firstRect = getOverlayPaintRect('pool-reuse', 'ambient');
  const settled = getWorldOverlayDiagnostics();
  for (let frame = 0; frame < 12; frame++) {
    env.advanceTime(16);
    env.postRender.raise();
  }
  const secondRect = getOverlayPaintRect('pool-reuse', 'ambient');
  const steady = getWorldOverlayDiagnostics();
  assert.ok(firstRect && secondRect);
  assert.equal(secondRect, firstRect);
  assert.equal(steady.paintedCount, settled.paintedCount);
  assert.equal(steady.paintItemPoolSize, settled.paintItemPoolSize);
  assert.equal(steady.paintRectPoolSize, settled.paintRectPoolSize);
  env.cleanup();
});

test('destroy empties paint pools and releases pooled record and entry payloads', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('pool-release', [selectedEntry('payload', {
    metadata: { retainedProbe: new Uint8Array(1024) },
  })]);
  env.postRender.raise();
  const firstRect = getOverlayPaintRect('pool-release', 'payload');
  const painting = getWorldOverlayDiagnostics();
  assert.ok(firstRect?.entry);
  assert.ok(painting.paintItemPoolSize >= 1);
  assert.ok(painting.paintRectPoolSize >= 1);

  destroyWorldOverlay();
  const released = getWorldOverlayDiagnostics();
  assert.equal(firstRect.entry, null);
  assert.equal(released.paintItemPoolSize, 0);
  assert.equal(released.paintRectPoolSize, 0);

  initWorldOverlay(env.viewer);
  setOverlayEntries('pool-release', [selectedEntry('next-payload')]);
  env.postRender.raise();
  assert.notEqual(getOverlayPaintRect('pool-release', 'next-payload'), firstRect);
  env.cleanup();
});

/** A position getter whose visibility can be toggled without touching the host. */
function togglablePosition(box) {
  return () => (box.hidden ? new Cesium.Cartesian3(0, 0, Number.NaN) : position());
}

test('a candidate that is not projected this frame stops painting immediately', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  const box = { hidden: false };
  setOverlayEntries('stamp', [selectedEntry('ambient', {
    selected: false,
    protected: false,
    collisionGroup: 'stamp',
    position: togglablePosition(box),
  })]);
  env.postRender.raise();
  env.advanceTime(200);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  const solveRevision = getWorldOverlayDiagnostics().solveRevision;

  box.hidden = true;
  env.advanceTime(16);
  env.postRender.raise();
  const after = getWorldOverlayDiagnostics();
  // The arbiter has NOT re-solved, so its state still reports this identity as
  // selected. Only the per-frame stamp can suppress the stale placement.
  assert.equal(after.solveRevision, solveRevision);
  assert.equal(after.paintedCount, 0);
  env.cleanup();
});

test('published paint rectangles are scoped to the publishing key and frame', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  const first = { hidden: false };
  const second = { hidden: false };
  setOverlayEntries('rects', [
    selectedEntry('aaa', { interactive: true, position: togglablePosition(first) }),
    selectedEntry('bbb', { interactive: true, position: togglablePosition(second) }),
  ]);
  env.postRender.raise();
  const rectA = getOverlayPaintRect('rects', 'aaa');
  const rectB = getOverlayPaintRect('rects', 'bbb');
  assert.ok(rectA && rectB);
  assert.notEqual(rectA, rectB);

  // 'aaa' drops out, so 'bbb' inherits the pooled slot 'aaa' used to own. The
  // index still maps 'aaa' to that slot, so identity must be re-checked.
  first.hidden = true;
  env.advanceTime(16);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  assert.equal(getOverlayPaintRect('rects', 'bbb'), rectA);
  assert.equal(getOverlayPaintRect('rects', 'aaa'), null);

  // Nothing paints: the slot still carries 'bbb' as its key, so only the frame
  // stamp keeps last frame's box from being handed back.
  second.hidden = true;
  env.advanceTime(16);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 0);
  assert.equal(getOverlayPaintRect('rects', 'bbb'), null);
  assert.equal(getOverlayPaintRect('rects', 'aaa'), null);
  env.cleanup();
});

test('every exported entry point is inert after destroy', () => {
  const env = installMockEnvironment();
  initWorldOverlay(env.viewer);
  setOverlayEntries('post-destroy', [selectedEntry('live', { interactive: true })]);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);

  destroyWorldOverlay();
  assert.equal(env.document.getElementById('world-overlay-root'), null);

  assert.doesNotThrow(() => setOverlayEntries('post-destroy', [selectedEntry('zombie')]));
  assert.doesNotThrow(() => setOverlayEntries('post-destroy', 'not-an-array'));
  assert.doesNotThrow(() => upsertOverlayEntry('post-destroy', { id: 'zombie-2', position: position() }));
  assert.equal(removeOverlayEntry('post-destroy', 'live'), false);
  assert.equal(clearOverlaySource('post-destroy'), false);
  assert.doesNotThrow(() => setOverlaySourceVisible('post-destroy', false));
  assert.equal(hitTestWorldOverlay(200, 120), null);
  assert.equal(getOverlayPaintRect('post-destroy', 'live'), null);
  assert.doesNotThrow(() => env.postRender.raise());

  const diagnostics = getWorldOverlayDiagnostics();
  assert.equal(diagnostics.sourceCount, 0);
  assert.equal(diagnostics.entryCount, 0);
  assert.equal(diagnostics.paintedCount, 0);
  assert.deepEqual(diagnostics.entriesBySource, {});
  assert.deepEqual(diagnostics.paintedBySource, {});

  // No DOM resurrection and no listener or observer re-registration.
  assert.equal(env.document.getElementById('world-overlay-root'), null);
  assert.equal(env.document.getElementById('world-overlay-canvas'), null);
  assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  assert.equal(env.postRender.listeners.size, 0);
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.window.listenerCount('gev:cockpit-mode-changed'), 0);
  assert.equal(env.window.listenerCount('resize'), 0);

  // A later init still produces a fully working host.
  initWorldOverlay(env.viewer);
  setOverlayEntries('post-destroy', [selectedEntry('revived', { interactive: true })]);
  env.postRender.raise();
  assert.equal(getWorldOverlayDiagnostics().paintedCount, 1);
  assert.equal(hitTestWorldOverlay(200, 120).entryId, 'revived');
  env.cleanup();
});

test('diagnostics facade preserves the complete binding shape', () => {
  const diagnostics = getWorldOverlayDiagnostics();
  const fields = [
    'sourceCount', 'entryCount', 'candidateCount', 'projectedCount', 'selectedCount',
    'fadingCount', 'paintedCount', 'hitRectCount', 'projectionMs', 'solveMs',
    'paintMs', 'solveRevision', 'paintItemPoolSize', 'paintRectPoolSize',
    'candidateIndexSize', 'entriesBySource', 'paintedBySource',
  ];
  assert.deepEqual(Object.keys(diagnostics).sort(), fields.sort());
});
