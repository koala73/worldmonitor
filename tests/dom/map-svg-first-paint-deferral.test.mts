/**
 * The SVG map (the renderer mobile uses) keeps heavy work off first paint
 * (#4429, #4442) and batches its layout reads before its writes (#5017):
 *
 *   - The first render paints the base map synchronously. It schedules the
 *     dynamic overlay layers once, for after first paint.
 *   - That first dynamic pass is chunked. It yields between layers and stops
 *     when a newer render supersedes it.
 *   - Scheduled renders read the container size in the measure phase and
 *     render in the mutate phase.
 *   - Label collision detection reads rects in the measure phase and writes
 *     opacity only in the mutate phase.
 *
 * The component runs on a prototype instance so the constructor's
 * d3/topojson/network boot stays out of the test. The per-layer builders are
 * stubbed because they are not under test. `render()`, `renderWithSize()`,
 * `renderInitialDynamicPass()`, `renderDynamicLayers()` and `destroy()` run
 * for real.
 * The test controls the after-paint scheduler, `yieldToMain`, and the layout
 * batch queues.
 */
import * as d3 from 'd3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  afterPaint: [] as Array<() => void>,
  yields: [] as Array<() => void>,
  measures: [] as Array<() => void>,
  mutates: [] as Array<() => void>,
}));

vi.mock('@/utils/after-paint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/after-paint')>(),
  scheduleAfterFirstPaint: (task: () => void) => { control.afterPaint.push(task); },
  yieldToMain: () => new Promise<void>((resolve) => { control.yields.push(resolve); }),
}));
vi.mock('@/utils/layout-batch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/layout-batch')>(),
  measure: (cb: () => void) => { control.measures.push(cb); return () => {}; },
  mutate: (cb: () => void) => { control.mutates.push(cb); return () => {}; },
}));

import { MapComponent } from '@/components/Map';

const LAYER_STEPS = [
  'renderCables',
  'renderPipelines',
  'renderConflicts',
  'renderAisDensity',
  'renderClusterLayer',
  'renderOverlays',
] as const;

type Step = typeof LAYER_STEPS[number];

type MapHarness = {
  render: () => void;
  destroy: () => void;
  applyTransform: ReturnType<typeof vi.fn>;
  scheduleRender: () => void;
  updateLabelVisibility: (zoom: number) => void;
  steps: Record<Step, ReturnType<typeof vi.fn>>;
  renderCountries: ReturnType<typeof vi.fn>;
  renderWithSize: (width: number, height: number) => void;
  container: HTMLElement;
  overlays: HTMLElement;
};

function drain(queue: Array<() => void>): void {
  const pending = queue.splice(0);
  for (const task of pending) task();
}

async function releaseYield(): Promise<void> {
  const pending = control.yields.splice(0);
  for (const release of pending) release();
  // Let the awaiting loop resume and run its next step.
  await Promise.resolve();
  await Promise.resolve();
}

function callOrder(map: MapHarness): Step[] {
  return LAYER_STEPS
    .flatMap((step) => map.steps[step].mock.invocationCallOrder.map((order) => ({ step, order })))
    .sort((a, b) => a.order - b.order)
    .map(({ step }) => step);
}

function createMap(): MapHarness {
  const map = Object.create(MapComponent.prototype) as Record<string, unknown>;
  const container = document.createElement('div');
  const overlays = document.createElement('div');
  const svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.append(svgNode, overlays);
  document.body.append(container);

  Object.assign(map, {
    container,
    overlays,
    svg: d3.select(svgNode),
    destroyed: false,
    lastRenderTime: Number.NEGATIVE_INFINITY,
    // No render throttle, so back-to-back render() calls reach renderWithSize.
    MIN_RENDER_INTERVAL_MS: 0,
    renderScheduled: false,
    lastContainerSize: { width: 800, height: 600 },
    baseLayerGroup: null,
    dynamicLayerGroup: null,
    baseRendered: false,
    baseWidth: 0,
    baseHeight: 0,
    countryFeatures: null,
    initialDynamicRendered: false,
    initialDynamicScheduled: false,
    dynamicRenderToken: 0,
    labelVisibilityScheduled: false,
    pendingLabelVisibilityZoom: 1,
    state: { layers: { cables: true, pipelines: true, conflicts: true, ais: true } },
    renderGrid: vi.fn(),
    renderGraticule: vi.fn(),
    renderCountries: vi.fn(),
    getProjection: vi.fn(() => d3.geoEquirectangular()),
    applyTransform: vi.fn(),
    updateCountryFills: vi.fn(),
    // Fields the real destroy() tears down.
    listenerAbort: new AbortController(),
    markerSettleTimer: null,
    overlayBudgetReplanTimer: null,
    activeFlashes: new Map(),
    resizeObserver: null,
    healthCheckLoop: null,
  });
  const steps = Object.fromEntries(LAYER_STEPS.map((step) => [step, vi.fn()])) as Record<Step, ReturnType<typeof vi.fn>>;
  Object.assign(map, steps, { steps });
  return map as unknown as MapHarness;
}

beforeEach(() => {
  control.afterPaint.length = 0;
  control.yields.length = 0;
  control.measures.length = 0;
  control.mutates.length = 0;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('SVG map first-paint deferral (#4429/#4442)', () => {
  it('paints the base map now and schedules the dynamic layers once for after first paint', () => {
    const map = createMap();

    map.render();
    map.render();

    expect(map.renderCountries).toHaveBeenCalled();
    expect(callOrder(map)).toEqual([]);
    expect(control.afterPaint).toHaveLength(1);
  });

  it('builds the first dynamic pass one layer per task, yielding between layers', async () => {
    const map = createMap();
    map.render();
    drain(control.afterPaint);

    expect(callOrder(map)).toEqual(['renderCables']);
    for (let built = 1; built < LAYER_STEPS.length; built++) {
      expect(control.yields).toHaveLength(1);
      await releaseYield();
      expect(callOrder(map)).toEqual(LAYER_STEPS.slice(0, built + 1));
    }
    expect(control.yields).toHaveLength(0);
  });

  it('abandons the chunked pass once a steady-state render supersedes it', async () => {
    const map = createMap();
    map.render();
    drain(control.afterPaint);
    expect(callOrder(map)).toEqual(['renderCables']);

    // The first pass has flipped initialDynamicRendered, so this render builds
    // every layer synchronously and bumps the render token.
    map.render();
    expect(callOrder(map)).toEqual(['renderCables', ...LAYER_STEPS]);

    await releaseYield();
    expect(callOrder(map)).toEqual(['renderCables', ...LAYER_STEPS]);
  });

  it('builds no further layer once the map is destroyed while the chunked pass waits on a yield', async () => {
    const map = createMap();
    map.render();
    drain(control.afterPaint);
    expect(callOrder(map)).toEqual(['renderCables']);
    expect(control.yields).toHaveLength(1);
    const transformsBeforeDestroy = map.applyTransform.mock.calls.length;

    map.destroy();
    await releaseYield();

    expect(callOrder(map)).toEqual(['renderCables']);
    expect(control.yields).toHaveLength(0);
    expect(map.applyTransform).toHaveBeenCalledTimes(transformsBeforeDestroy);
  });
});

describe('SVG map layout batching (#5017)', () => {
  it('reads the container size in measure and renders in mutate', () => {
    const map = createMap();
    let sizeReads = 0;
    Object.defineProperty(map.container, 'clientWidth', { configurable: true, get: () => { sizeReads += 1; return 640; } });
    Object.defineProperty(map.container, 'clientHeight', { configurable: true, get: () => 480 });
    const renderWithSize = vi.fn();
    map.renderWithSize = renderWithSize;

    map.scheduleRender();
    expect(sizeReads).toBe(0);

    drain(control.measures);
    expect(sizeReads).toBe(1);
    expect(renderWithSize).not.toHaveBeenCalled();

    drain(control.mutates);
    expect(renderWithSize).toHaveBeenCalledWith(640, 480);
  });

  it('measures label rects without writing opacity, then writes opacity in mutate', () => {
    const map = createMap();
    const hotspot = document.createElement('div');
    hotspot.className = 'hotspot';
    const label = document.createElement('span');
    label.className = 'hotspot-label';
    hotspot.append(label);
    map.overlays.append(hotspot);
    const readRect = vi.spyOn(label, 'getBoundingClientRect');

    map.updateLabelVisibility(1);
    drain(control.measures);
    expect(readRect).toHaveBeenCalledTimes(1);
    expect(label.style.opacity).toBe('');

    drain(control.mutates);
    expect(label.style.opacity).toBe('1');
  });
});
