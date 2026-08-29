import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeMaskGeometry,
  scopeMaskDevicePixelRatio,
  scopeTerminusAlpha,
  quantizeScopeTerminusAlpha,
  updateScopeTerminusForHeight,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  getScopeTerminusAlpha,
  getScopeTerminusRepaintCount,
  clampScopeTerminusPct,
  installScopeMask,
  destroyScopeMask,
  setScopeMaskEnabled,
  setScopeMaskFeather,
  SCOPE_TERMINUS_MIN_PCT,
  SCOPE_TERMINUS_MAX_PCT,
  SCOPE_FEATHER_RATIO_DEFAULT,
  SCOPE_OUTSIDE_ALPHA,
  SCOPE_TERMINUS_ALPHA_NEAR,
  SCOPE_TERMINUS_FAR_M,
  SCOPE_TERMINUS_NEAR_M,
  SCOPE_TERMINUS_QUANTUM,
  _resetScopeMaskForTest,
} from './scopeMask.js';
import { KEYHOLE_OUTER_RADIUS } from './celestialRing.js';

beforeEach(() => _resetScopeMaskForTest());

test('geometry anchors the visible edge to the shared keyhole radius', () => {
  const geo = scopeMaskGeometry(1440, 860, 0.4);
  const keyholeR = 860 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.ok(geo);
  assert.equal(geo.centerX, 720);
  assert.equal(geo.centerY, 430);
  // Feather straddles the keyhole edge: inner+outer average = keyhole radius.
  assert.ok(Math.abs((geo.innerR + geo.outerR) / 2 - keyholeR) < 1e-9);
  assert.ok(Math.abs((geo.outerR - geo.innerR) - keyholeR * 0.4) < 1e-9);
});

test('zero feather produces a hard edge exactly at the keyhole radius', () => {
  const geo = scopeMaskGeometry(1000, 800, 0);
  const keyholeR = 800 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.equal(geo.innerR, keyholeR);
  assert.equal(geo.outerR, keyholeR);
});

test('feather ratio is clamped to [0,1] and bad input falls back to 0', () => {
  const wide = scopeMaskGeometry(1000, 800, 7);
  const one = scopeMaskGeometry(1000, 800, 1);
  assert.equal(wide.innerR, one.innerR);
  assert.equal(wide.outerR, one.outerR);
  const nan = scopeMaskGeometry(1000, 800, Number.NaN);
  const zero = scopeMaskGeometry(1000, 800, 0);
  assert.equal(nan.innerR, zero.innerR);
});

test('degenerate viewport yields null instead of a broken gradient', () => {
  assert.equal(scopeMaskGeometry(0, 0), null);
  assert.equal(scopeMaskGeometry(-5, 100), null);
});

test('an omitted feather argument uses the module default, whatever it is', () => {
  // The assertion here is the WIRING — that calling scopeMaskGeometry with no
  // ratio really consults SCOPE_FEATHER_RATIO_DEFAULT rather than some second,
  // private constant. Comparing the omitted-argument geometry against an
  // explicitly-passed default keeps that alive at ANY default value. The old
  // form (band width === keyholeR × default) went VACUOUSLY true the moment the
  // default moved to 0 on 2026-08-22 — both sides collapse to zero — so it is
  // written this way deliberately.
  const omitted = scopeMaskGeometry(1200, 900);
  const explicit = scopeMaskGeometry(1200, 900, SCOPE_FEATHER_RATIO_DEFAULT);
  assert.equal(omitted.innerR, explicit.innerR);
  assert.equal(omitted.outerR, explicit.outerR);
  // And it is not simply ignoring the argument: a different ratio must differ,
  // and must still derive its band from the keyhole radius.
  const wider = scopeMaskGeometry(1200, 900, SCOPE_FEATHER_RATIO_DEFAULT + 0.4);
  assert.notEqual(wider.outerR - wider.innerR, omitted.outerR - omitted.innerR);
  const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.ok(Math.abs((wider.outerR - wider.innerR)
    - keyholeR * (SCOPE_FEATHER_RATIO_DEFAULT + 0.4)) < 1e-9);
  // The default's VALUE (hidden feather, product invariant 2026-08-22) is pinned
  // with the rest of the first-run batch in reasonableDefaults.test.mjs.
});

test('backing-store scale is clamped to 2x and survives junk input', () => {
  assert.equal(scopeMaskDevicePixelRatio(1), 1);
  assert.equal(scopeMaskDevicePixelRatio(2), 2);
  assert.equal(scopeMaskDevicePixelRatio(3), 2); // clamp — a 3x panel still draws at 2x
  assert.equal(scopeMaskDevicePixelRatio(0), 1);
  assert.equal(scopeMaskDevicePixelRatio(Number.NaN), 1);
});

/**
 * Minimal DOM/matchMedia surface for the install path. Returns the created
 * canvas plus a `setDpr` that fires a real `(resolution: Ndppx)` change the
 * way moving a window between a 1x and a 2x monitor does.
 */
function stubScopeMaskDom({ width = 1000, height = 800, dpr = 1 } = {}) {
  const saved = { window: globalThis.window, document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
  // Records every fillStyle assignment and gradient stop so the paint's actual
  // colours (not just its call sequence) can be asserted.
  const fillStyles = [];
  const gradientStops = [];
  // Canvas work actually performed — the disabled scope must do none of it.
  const ops = { resizes: 0, clears: 0, fills: 0 };
  const canvas = {
    id: '', style: {},
    _width: 0, _height: 0,
    set width(value) { ops.resizes += 1; this._width = value; },
    get width() { return this._width; },
    set height(value) { this._height = value; },
    get height() { return this._height; },
    setAttribute() {}, remove() {},
    getContext: () => ({
      setTransform() {}, beginPath() {}, rect() {}, arc() {},
      clearRect() { ops.clears += 1; },
      fill() { ops.fills += 1; },
      fillRect() { ops.fills += 1; },
      createRadialGradient: () => ({
        addColorStop(offset, color) { gradientStops.push({ offset, color }); },
      }),
      set fillStyle(value) { if (typeof value === 'string') fillStyles.push(value); },
      get fillStyle() { return fillStyles[fillStyles.length - 1] || ''; },
    }),
  };
  const listeners = new Set();
  globalThis.window = {
    devicePixelRatio: dpr,
    matchMedia: (query) => ({
      media: query,
      matches: true,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
    }),
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const container = { clientWidth: width, clientHeight: height, appendChild() {} };
  return {
    canvas,
    container,
    /** Canvas work counters: backing-store resizes, clears, fills. */
    ops,
    /** Every fillStyle string assigned since install (hard-crop path). */
    fillStyles: () => [...fillStyles],
    /** Every gradient stop added since install (feathered path). */
    gradientStops: () => [...gradientStops],
    setDpr(next) {
      globalThis.window.devicePixelRatio = next;
      for (const fn of [...listeners]) fn();
    },
    restore() {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.ResizeObserver = saved.ResizeObserver;
    },
  };
}

test('a DPR change with no resize still repaints the backing store', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    // 1x monitor: backing store matches CSS pixels.
    assert.equal(dom.canvas.width, 1000);
    assert.equal(dom.canvas.height, 800);

    // Window dragged to a 2x monitor. The content box never changed, so the
    // ResizeObserver stays silent — only the DPR watch can catch this.
    dom.setDpr(2);
    assert.equal(dom.canvas.width, 2000, 'backing store must follow the new DPR');
    assert.equal(dom.canvas.height, 1600);

    // And back again — the listener must be re-armed after each change.
    dom.setDpr(1);
    assert.equal(dom.canvas.width, 1000, 'DPR watch must re-arm, not fire once');
    assert.equal(dom.canvas.height, 800);
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

test('destroy tears the DPR watch down (no redraw after teardown)', () => {
  const dom = stubScopeMaskDom({ width: 640, height: 480, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    assert.equal(dom.canvas.width, 640);
    destroyScopeMask();
    dom.setDpr(2);
    assert.equal(dom.canvas.width, 640, 'a destroyed mask must not repaint');
  } finally {
    dom.restore();
  }
});

// ── Altitude-adaptive edge terminus ──────────────────────────────────────────
//
// 0.94 is right at TRUE full-globe altitude (faint stars survive in the
// corners) and wrong everywhere else, where the same 6% bleed reads as smeared
// geometry. Field band retune (2026-08-17): the fade STARTS at
// ~10 Mm and is finished by ~7 Mm, so every working altitude is solid black.
// FEATHER behavior is outside this terminus-band test and remains unchanged.

test('the terminus band is the validated 10 Mm → 7 Mm fade', () => {
  assert.equal(SCOPE_TERMINUS_FAR_M, 10_000_000, 'the relaxed corners start above 10 Mm');
  assert.equal(SCOPE_TERMINUS_NEAR_M, 7_000_000, 'and are gone by 7 Mm');
  assert.equal(scopeTerminusAlpha(10_500_000), SCOPE_OUTSIDE_ALPHA, 'full-globe view keeps its stars');
  assert.equal(scopeTerminusAlpha(6_900_000), SCOPE_TERMINUS_ALPHA_NEAR, 'below the band: solid black');
  assert.equal(scopeTerminusAlpha(400_000), SCOPE_TERMINUS_ALPHA_NEAR, 'orbital view: solid black');
  assert.equal(scopeTerminusAlpha(1_500), SCOPE_TERMINUS_ALPHA_NEAR, 'city view: solid black');
  // Quick, not gradual: a fifth of the way down the band it is already past halfway.
  const fifth = SCOPE_TERMINUS_FAR_M - (SCOPE_TERMINUS_FAR_M - SCOPE_TERMINUS_NEAR_M) * 0.5;
  assert.ok(scopeTerminusAlpha(fifth) > SCOPE_OUTSIDE_ALPHA + 0.02,
    'the fade must be well underway by mid-band');
});

test('terminus ramp: translucent at globe scale, full black up close', () => {
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_FAR_M), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_FAR_M + 1_000_000), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M), SCOPE_TERMINUS_ALPHA_NEAR);
  assert.equal(scopeTerminusAlpha(0), SCOPE_TERMINUS_ALPHA_NEAR);
});

test('terminus ramp is monotonic, bounded, and eased at both ends', () => {
  const mid = (SCOPE_TERMINUS_FAR_M + SCOPE_TERMINUS_NEAR_M) / 2;
  assert.ok(Math.abs(scopeTerminusAlpha(mid) - (SCOPE_OUTSIDE_ALPHA + 0.06 / 2)) < 1e-9,
    'smoothstep is symmetric — the midpoint sits halfway');

  let previous = -Infinity;
  for (let h = 15_000_000; h >= 0; h -= 100_000) {
    const alpha = scopeTerminusAlpha(h);
    assert.ok(alpha >= previous, `alpha must never decrease while descending (h=${h})`);
    assert.ok(alpha >= SCOPE_OUTSIDE_ALPHA && alpha <= 1, `alpha out of range at h=${h}`);
    previous = alpha;
  }

  // Eased, not linear: near each end the slope is gentler than the midpoint's.
  const step = 100_000;
  const nearEnd = scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M + step) - scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M);
  const middle = scopeTerminusAlpha(mid) - scopeTerminusAlpha(mid + step);
  assert.ok(Math.abs(nearEnd) < Math.abs(middle), 'the ramp must ease into the near clamp');
});

test('terminus ramp survives junk heights without breaking the paint', () => {
  assert.equal(scopeTerminusAlpha(Number.NaN), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(undefined), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(Number.POSITIVE_INFINITY), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(-1000), SCOPE_TERMINUS_ALPHA_NEAR, 'below the datum is still "close"');
});

test('quantization snaps to the repaint grid', () => {
  assert.equal(quantizeScopeTerminusAlpha(0.9412), 0.94);
  assert.equal(quantizeScopeTerminusAlpha(0.9436), 0.945);
  assert.equal(quantizeScopeTerminusAlpha(1), 1);
  assert.equal(quantizeScopeTerminusAlpha(5), 1, 'clamped');
  assert.equal(quantizeScopeTerminusAlpha(Number.NaN), 0);
});

test('repaint gate: only a QUANTIZED step repaints; hovering costs nothing', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    const base = getScopeTerminusRepaintCount();

    // Parked at true full-globe altitude: the seeded alpha already matches, so
    // no repaint — and repeating the identical sample stays free.
    assert.equal(updateScopeTerminusForHeight(14_000_000), false);
    assert.equal(updateScopeTerminusForHeight(14_000_000), false);
    assert.equal(getScopeTerminusRepaintCount(), base, 'a still camera must never repaint');

    // A real step repaints exactly once, then holds.
    assert.equal(updateScopeTerminusForHeight(SCOPE_TERMINUS_NEAR_M), true);
    assert.equal(getScopeTerminusAlpha(), 1);
    assert.equal(updateScopeTerminusForHeight(SCOPE_TERMINUS_NEAR_M), false);
    assert.equal(getScopeTerminusRepaintCount(), base + 1);

    // A sub-quantum drift inside the ramp must NOT repaint. One 0.005 step is
    // ~166 km of altitude at mid-band, so 1 km is nowhere near it.
    updateScopeTerminusForHeight(8_500_000);
    const afterMid = getScopeTerminusRepaintCount();
    updateScopeTerminusForHeight(8_501_000);
    assert.equal(getScopeTerminusRepaintCount(), afterMid, 'sub-quantum drift must not repaint');
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

test('a full zoom-in gesture costs only a handful of repaints', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    const base = getScopeTerminusRepaintCount();

    // 20 Mm → ground in 10 km steps: ~2000 samples across the whole descent,
    // far denser than the 120 ms sampler could ever produce in a real gesture,
    // and covering the entire retuned band with room on both sides.
    for (let h = 20_000_000; h >= 0; h -= 10_000) updateScopeTerminusForHeight(h);
    const repaints = getScopeTerminusRepaintCount() - base;

    // The ramp spans 0.06 alpha at 0.005 granularity → at most 13 distinct steps.
    assert.ok(repaints <= 13, `expected ≤13 repaints across the descent, got ${repaints}`);
    assert.ok(repaints >= 5, `expected a visibly smooth ramp, got only ${repaints}`);
    assert.equal(getScopeTerminusAlpha(), 1, 'the descent must end fully opaque');
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

test('an override pins the terminus and null restores the ramp', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    setScopeTerminusOverride(0.97);
    assert.equal(getScopeTerminusOverride(), 0.97);
    assert.equal(getScopeTerminusAlpha(), 0.97);

    // Pinned: altitude no longer moves it.
    assert.equal(updateScopeTerminusForHeight(0), false);
    assert.equal(getScopeTerminusAlpha(), 0.97);

    setScopeTerminusOverride(null);
    assert.equal(getScopeTerminusOverride(), null);
    assert.equal(updateScopeTerminusForHeight(0), true, 'the ramp is live again');
    assert.equal(getScopeTerminusAlpha(), 1);
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

test('the hard-crop (feather 0) path honors the same terminus alpha', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    updateScopeTerminusForHeight(SCOPE_TERMINUS_FAR_M + 5_000_000); // true full-globe view
    setScopeMaskFeather(0); // hard crop — the evenodd rect-minus-circle path
    // The globe-scale seed paint is legitimately in the history, so assert on
    // the LAST fill: what the hard crop is painting right now, zoomed in.
    const beforeDescent = dom.fillStyles().at(-1);
    assert.equal(beforeDescent, `rgba(5,5,8,${SCOPE_OUTSIDE_ALPHA})`,
      'at globe scale the hard crop is still the translucent terminus');

    updateScopeTerminusForHeight(SCOPE_TERMINUS_NEAR_M);
    assert.equal(dom.fillStyles().at(-1), 'rgba(5,5,8,1)',
      'a zoomed-in hard crop must paint fully opaque, not the globe-scale 0.94');
  } finally {
    setScopeMaskFeather(SCOPE_FEATHER_RATIO_DEFAULT);
    destroyScopeMask();
    dom.restore();
  }
});

test('one quantum is the smallest step that can repaint', () => {
  assert.ok(SCOPE_TERMINUS_QUANTUM > 0 && SCOPE_TERMINUS_QUANTUM < 0.06,
    'the quantum must be finer than the ramp it gates');
});

// ── SCOPE OFF must be the cheapest state (second review) ─────────────────────
//
// With sc=0 the mask paints nothing, but the camera listeners still sampled at
// ~8 Hz through the altitude band and draw() performed the full backing-store
// resize + clear BEFORE checking whether the scope was even enabled.

/** A viewer stub with the two camera signals the terminus sampler listens on. */
function stubScopeViewer(container, heightM) {
  const preRenderListeners = new Set();
  const moveEndListeners = new Set();
  const positionCartographic = { height: heightM };
  const addTo = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  return {
    viewer: {
      container,
      scene: { preRender: { addEventListener: addTo(preRenderListeners) } },
      camera: { positionCartographic, moveEnd: { addEventListener: addTo(moveEndListeners) } },
    },
    setHeight(next) { positionCartographic.height = next; },
    raisePreRender(times = 1) {
      for (let i = 0; i < times; i += 1) for (const fn of [...preRenderListeners]) fn();
    },
    raiseMoveEnd() { for (const fn of [...moveEndListeners]) fn(); },
  };
}

test('a disabled scope does no canvas work and samples no camera heights', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  const rig = stubScopeViewer(dom.container, 14_000_000); // true full-globe view
  try {
    installScopeMask(rig.viewer);
    assert.equal(getScopeTerminusAlpha(), SCOPE_OUTSIDE_ALPHA);

    // The transition must clear the painted mask EXACTLY once, and must not
    // resize the backing store to do it.
    const beforeDisable = { ...dom.ops };
    setScopeMaskEnabled(false);
    const afterDisable = { ...dom.ops };
    assert.equal(afterDisable.clears, beforeDisable.clears + 1,
      'the disable transition clears the mask exactly once');
    assert.equal(afterDisable.resizes, beforeDisable.resizes,
      'and clears without a backing-store resize');
    assert.equal(afterDisable.fills, beforeDisable.fills, 'and paints nothing');

    // A second disable is inert — the canvas already holds no ink.
    setScopeMaskEnabled(false);
    assert.deepEqual(dom.ops, afterDisable, 'a repeated disable must re-clear nothing');

    // Fly the whole band while OFF: the sampler must not read the camera, and
    // no draw may touch the backing store.
    rig.setHeight(1_000);
    rig.raisePreRender(40);
    rig.raiseMoveEnd();
    setScopeMaskFeather(0.5); // any tuning write still routes through draw()
    assert.deepEqual(dom.ops, afterDisable, 'a disabled scope must do NO canvas work');
    assert.equal(getScopeTerminusAlpha(), SCOPE_OUTSIDE_ALPHA, 'and must not track the camera');

    // Re-enable: the alpha it skipped is re-synced once, before the first paint.
    const beforeEnable = { ...dom.ops };
    setScopeMaskEnabled(true);
    assert.equal(getScopeTerminusAlpha(), SCOPE_TERMINUS_ALPHA_NEAR,
      're-enabling must re-sync the terminus it stopped sampling');
    assert.ok(dom.ops.resizes > beforeEnable.resizes, 'and repaint at the live altitude');
  } finally {
    setScopeMaskFeather(SCOPE_FEATHER_RATIO_DEFAULT);
    destroyScopeMask();
    dom.restore();
  }
});

test('a DPR change that also crosses a terminus step paints once, not twice', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  const rig = stubScopeViewer(dom.container, SCOPE_TERMINUS_FAR_M);
  try {
    installScopeMask(rig.viewer);
    assert.equal(getScopeTerminusAlpha(), SCOPE_OUTSIDE_ALPHA);

    // Descend into the band WITHOUT a frame, then drag the window to a 2x
    // monitor: the DPR change and the pending terminus step land together.
    rig.setHeight(8_500_000);
    const before = { ...dom.ops };
    const repaintsBefore = getScopeTerminusRepaintCount();
    dom.setDpr(2);

    assert.equal(dom.ops.resizes - before.resizes, 1, 'both changes must share ONE paint');
    assert.equal(dom.canvas.width, 2000, 'and it must be at the new backing-store scale');
    assert.equal(getScopeTerminusAlpha(), 0.97, 'with the stepped terminus already folded in');
    assert.equal(getScopeTerminusRepaintCount(), repaintsBefore + 1, 'counted as one repaint');
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

// ── `sce` band clamp (shared by the share layer and the UI) ──────────────────

test('terminus percents clamp into the supported band; junk is absent, not zero', () => {
  assert.equal(SCOPE_TERMINUS_MIN_PCT, 94);
  assert.equal(SCOPE_TERMINUS_MAX_PCT, 100);
  assert.equal(clampScopeTerminusPct(97), 97);
  assert.equal(clampScopeTerminusPct(96.6), 97);
  assert.equal(clampScopeTerminusPct(0), 94, 'a sub-band value is floored, never honoured');
  assert.equal(clampScopeTerminusPct(93), 94);
  assert.equal(clampScopeTerminusPct(-100), 94);
  assert.equal(clampScopeTerminusPct(1000), 100);
  assert.equal(clampScopeTerminusPct('98'), 98, 'hash values arrive as strings');
  assert.equal(clampScopeTerminusPct(null), null, 'absent means adaptive, not 0');
  assert.equal(clampScopeTerminusPct(undefined), null);
  assert.equal(clampScopeTerminusPct(''), null);
  assert.equal(clampScopeTerminusPct('abc'), null);
  assert.equal(clampScopeTerminusPct(Number.NaN), null);
  assert.equal(clampScopeTerminusPct(true), null);
});

test('a pinned override is floored to the band at every entry point', () => {
  const dom = stubScopeMaskDom({ width: 1000, height: 800, dpr: 1 });
  try {
    installScopeMask({ container: dom.container });
    setScopeTerminusOverride(0); // an sce=0 link, or any stale caller
    assert.equal(getScopeTerminusOverride(), SCOPE_OUTSIDE_ALPHA,
      'a fully transparent terminus is a hole in the mask, not a scope');
    assert.equal(getScopeTerminusAlpha(), SCOPE_OUTSIDE_ALPHA);

    setScopeTerminusOverride(5);
    assert.equal(getScopeTerminusOverride(), 1, 'and the ceiling still holds');
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});
