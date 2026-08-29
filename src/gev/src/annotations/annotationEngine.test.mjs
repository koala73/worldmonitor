// Voice-annotation resilience contract tests — pure logic, no network, no browser.
//
// Locks the 2026-07-21 field-test fixes:
//   1. A TRANSIENT (undefined) deferred-outline resolution is retried with backoff
//      (the /api/overpass proxy caches the late completion, so a retry is nearly
//      free) instead of silently leaving the mark a point forever. A DEFINITIVE
//      miss (null) is never retried — honest point beats hammering Overpass.
//   2. targetKey normalization strips trailing locality qualifiers so "California"
//      and "California, United States" dedupe while their outlines are pending
//      (identity is GEOMETRY once resolved; targetKey is only the pending stand-in).
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnnotationEngine,
  resolveOutlineWithRetry,
  normalizeTargetKey,
} from './annotationEngine.js';
import { resolveAnnotationTarget } from './annotationResolver.js';
import {
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

// A resolver that replays a scripted sequence of outcomes (undefined = transient,
// null = definitive miss, object = footprint) and counts its invocations.
function scriptedResolver(outcomes) {
  const calls = { count: 0 };
  const resolve = async () => {
    const i = Math.min(calls.count, outcomes.length - 1);
    calls.count += 1;
    const out = outcomes[i];
    if (out instanceof Error) throw out;
    return out;
  };
  return { resolve, calls };
}

// Instant fake wait that records the requested backoff delays.
function fakeWait() {
  const delays = [];
  const waitFn = async (ms) => { delays.push(ms); };
  return { waitFn, delays };
}

const FP = { ring: [[0, 0], [0, 1], [1, 1], [0, 0]], footprintKind: 'area' };

function installAnimationFrameStubs(t) {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });
}

function fakeRenderer() {
  const calls = { add: 0, update: 0, remove: 0 };
  return {
    calls,
    renderer: {
      add() { calls.add += 1; },
      update() { calls.update += 1; },
      remove() { calls.remove += 1; },
      sync() {},
    },
  };
}

async function flushMicrotasks(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function httpFailure(status, retryAfter = null) {
  return {
    ok: false,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  };
}

test('retry: first-try footprint returns immediately, no retry, no waiting', async () => {
  const { resolve, calls } = scriptedResolver([FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, FP);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('retry: a DEFINITIVE miss (null) is never retried — the honest point stands', async () => {
  const { resolve, calls } = scriptedResolver([null, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('retry: a TRANSIENT miss (undefined) re-runs after the first backoff and can succeed', async () => {
  const { resolve, calls } = scriptedResolver([undefined, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, FP);
  assert.equal(calls.count, 2);
  assert.deepEqual(delays, [8000]); // waited once, succeeded on attempt 2
});

test('retry: a transient retry can still conclude with a definitive miss (no third run)', async () => {
  const { resolve, calls } = scriptedResolver([undefined, null]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 2);
  assert.deepEqual(delays, [8000]);
});

test('retry: persistent transients exhaust the backoff schedule and give up as transient', async () => {
  const { resolve, calls } = scriptedResolver([undefined, undefined, undefined, FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, undefined); // never found within budget — mark honestly stays a point
  assert.equal(calls.count, 3); // initial + one per backoff entry
  assert.deepEqual(delays, [8000, 25000]);
});

test('retry: a stale board (clear/supersede during backoff) stops retrying immediately', async () => {
  const { resolve, calls } = scriptedResolver([undefined, FP]);
  const { waitFn, delays } = fakeWait();
  let stale = false;
  const fp = await resolveOutlineWithRetry(resolve, {
    delaysMs: [8000, 25000],
    waitFn: async (ms) => { await waitFn(ms); stale = true; }, // goes stale mid-wait
    isStale: () => stale,
  });
  assert.equal(fp, undefined);
  assert.equal(calls.count, 1); // never re-ran against a superseded board
  assert.deepEqual(delays, [8000]);
});

test('retry: a thrown resolver is a definitive miss (no retry), matching the old catch→point path', async () => {
  const { resolve, calls } = scriptedResolver([new Error('boom'), FP]);
  const { waitFn, delays } = fakeWait();
  const fp = await resolveOutlineWithRetry(resolve, { delaysMs: [8000, 25000], waitFn });
  assert.equal(fp, null);
  assert.equal(calls.count, 1);
  assert.deepEqual(delays, []);
});

test('outline queue: an 8-spec batch keeps at most two FIFO upgrades in flight', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer, calls } = fakeRenderer();
  const started = [];
  const releases = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  const resolveTarget = async ({ target }) => {
    const index = Number(target.slice('queue-'.length));
    return {
      lon: index,
      lat: index,
      height: 0,
      label: target,
      source: 'fake',
      ring: null,
      resolveOutline: () => new Promise((resolve) => {
        started.push(target);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        releases.set(target, () => {
          inFlight -= 1;
          resolve({
            ring: [[index, index], [index + 0.1, index], [index, index + 0.1], [index, index]],
            footprintKind: 'area',
            lat: index,
            lon: index,
            height: 0,
          });
        });
      }),
    };
  };
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });
  let completed = 0;
  const allCompleted = new Promise((resolve) => engine.onOutlineEvent(() => {
    completed += 1;
    if (completed === 8) resolve();
  }));

  const result = await engine.annotate(Array.from({ length: 8 }, (_, i) => ({
    type: 'area',
    target: `queue-${i}`,
    footprint: true,
  })));

  assert.equal(result.drawn, 8);
  assert.equal(calls.add, 8, 'all point renders land before queued outlines finish');
  assert.deepEqual(started, ['queue-0', 'queue-1']);
  for (let next = 2; next < 8; next += 1) {
    releases.get(`queue-${next - 2}`)();
    await flushMicrotasks();
    assert.equal(started[next], `queue-${next}`, 'queued upgrades start in ask order');
  }
  releases.get('queue-6')();
  releases.get('queue-7')();
  await allCompleted;

  assert.equal(maxInFlight, 2);
  assert.equal(calls.update, 8);
});

test('outline queue: clear drops queued-but-unstarted upgrades without a later fetch', async (t) => {
  installAnimationFrameStubs(t);
  const { renderer } = fakeRenderer();
  let fetchesStarted = 0;
  const resolveTarget = async ({ target, signal }) => ({
    lon: Number(target.slice('clear-'.length)),
    lat: 10,
    height: 0,
    label: target,
    source: 'fake',
    ring: null,
    resolveOutline: () => new Promise((resolve) => {
      fetchesStarted += 1;
      const finish = () => resolve(undefined);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }),
  });
  const engine = createAnnotationEngine({ viewer: {}, renderer, resolveTarget });

  await engine.annotate(Array.from({ length: 8 }, (_, i) => ({
    type: 'area',
    target: `clear-${i}`,
    footprint: true,
  })));
  assert.equal(fetchesStarted, 2);

  engine.clear();
  await flushMicrotasks();
  assert.equal(engine.count(), 0);
  assert.equal(fetchesStarted, 2, 'the six queued upgrades were dropped on clear');
});

test('retry: HTTP 429 Retry-After 5s gets one ladder-spaced retry; a second 429 stops', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const requestTimes = [];
  globalThis.fetch = async () => {
    requestTimes.push(Date.now());
    return httpFailure(429, '5');
  };
  t.after(() => {
    t.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: {},
    target: 'PT2 rate-limit fixture',
    latitude: 12.345,
    longitude: 67.89,
    footprint: true,
    deferFootprint: true,
    entityKind: 'district',
  });
  let settled = false;
  const waits = [];
  const pending = resolveOutlineWithRetry(resolved.resolveOutline, {
    waitFn: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  })
    .finally(() => { settled = true; });
  while (waits.length === 0) await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  assert.deepEqual(waits, [8000], 'the 8s ladder floor is longer than Retry-After: 5');

  t.mock.timers.tick(7999);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  // Mutation hygiene: if 429 is accidentally collapsed into ordinary transient,
  // drain its forbidden second ladder timer before making the named assertions.
  if (waits.length > 1) {
    t.mock.timers.tick(waits[1]);
    await flushMicrotasks();
  }

  assert.equal(requestTimes.length, 2);
  assert.ok(requestTimes[1] - requestTimes[0] >= 5000, 'Retry-After is a hard minimum');
  assert.equal(settled, true, 'a second 429 must not schedule the 25s ladder replay');
  assert.equal(await pending, undefined);
});

test('retry: a plain HTTP 500 still exhausts the existing 8s/25s transient ladder', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const requestTimes = [];
  globalThis.fetch = async () => {
    requestTimes.push(Date.now());
    return httpFailure(500);
  };
  t.after(() => {
    t.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: {},
    target: 'PT2 transient fixture',
    latitude: -12.345,
    longitude: -67.89,
    footprint: true,
    deferFootprint: true,
    entityKind: 'district',
  });
  let settled = false;
  const waits = [];
  const pending = resolveOutlineWithRetry(resolved.resolveOutline, {
    waitFn: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  })
    .finally(() => { settled = true; });
  while (waits.length === 0) await flushMicrotasks();
  assert.equal(requestTimes.length, 1);
  assert.deepEqual(waits, [8000]);

  t.mock.timers.tick(8000);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 2);
  assert.equal(settled, false);
  assert.deepEqual(waits, [8000, 25_000]);
  t.mock.timers.tick(24_999);
  await flushMicrotasks();
  assert.equal(requestTimes.length, 2);
  t.mock.timers.tick(1);
  await flushMicrotasks();

  assert.equal(requestTimes.length, 3);
  assert.deepEqual(requestTimes.map((at) => at - requestTimes[0]), [0, 8000, 33_000]);
  assert.equal(settled, true);
  assert.equal(await pending, undefined);
});

test('targetKey: trailing locality qualifiers are stripped so state names dedupe', () => {
  assert.equal(normalizeTargetKey('California'), 'california');
  assert.equal(normalizeTargetKey('California, United States'), 'california');
  assert.equal(
    normalizeTargetKey('California'),
    normalizeTargetKey('California, United States'),
  );
});

test('targetKey: lowercases, trims, and keeps comma-free names intact', () => {
  assert.equal(normalizeTargetKey('  Texas State Capitol  '), 'texas state capitol');
  assert.equal(normalizeTargetKey('Lady Bird Lake'), 'lady bird lake');
});

test('targetKey: multi-qualifier names keep only the leading place name', () => {
  assert.equal(normalizeTargetKey('Sixth Street, Austin, TX'), 'sixth street');
});

test('targetKey: empty / absent targets stay null (coord and pixel specs never pending-collapse)', () => {
  assert.equal(normalizeTargetKey(''), null);
  assert.equal(normalizeTargetKey('   '), null);
  assert.equal(normalizeTargetKey(null), null);
  assert.equal(normalizeTargetKey(undefined), null);
});

test('outline upgrade updates the rendered element in place without remove/add', async (t) => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = {
    __GOOGLE_MAPS_API_KEY__: 'unit-test-key',
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let overpassCall = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => ({
        status: 'OK',
        results: [{
          formatted_address: 'FB-3 Engine Texas Fixture',
          types: ['administrative_area_level_1', 'political'],
          address_components: [{
            long_name: 'FB-3 Engine Texas Fixture',
            types: ['administrative_area_level_1', 'political'],
          }],
          geometry: { location: { lat: 31, lng: -99 } },
        }],
      }) };
    }
    assert.equal(String(url), '/api/gev/overpass');
    overpassCall += 1;
    if (overpassCall === 1) {
      return {
        ok: true,
        json: async () => ({ elements: [{
          type: 'area',
          id: 54321,
          tags: { name: 'FB-3 Engine Texas Fixture', admin_level: '4' },
        }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({ elements: [{
        type: 'relation',
        geometry: [
          { lon: -106, lat: 25 },
          { lon: -93, lat: 25 },
          { lon: -93, lat: 36 },
          { lon: -106, lat: 36 },
          { lon: -106, lat: 25 },
        ],
      }] }),
    };
  };
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const calls = { add: 0, update: 0, remove: 0 };
  const elements = new Map();
  let originalElement = null;
  const renderer = {
    add(anno) {
      calls.add += 1;
      originalElement = { id: anno.id };
      elements.set(anno.id, originalElement);
    },
    update(anno) {
      calls.update += 1;
      assert.equal(elements.get(anno.id), originalElement);
    },
    remove() { calls.remove += 1; },
    sync() {},
  };
  const viewer = {};
  const engine = createAnnotationEngine({ viewer, renderer });
  const upgraded = new Promise((resolve) => engine.onOutlineEvent(resolve));

  const result = await engine.annotate([{
    type: 'area',
    target: 'FB-3 Engine Texas Fixture',
    label: 'Texas',
    footprint: true,
  }]);
  await upgraded;

  assert.equal(result.drawn, 1);
  assert.deepEqual(calls, { add: 1, update: 1, remove: 0 });
  assert.equal(elements.get(result.ids[0]), originalElement, 'rendered element identity survives');
  assert.deepEqual(engine.list()[0].anchor, { lon: -100.8, lat: 29.4, height: 0 });
  assert.equal(engine.list()[0].ring.length, 5, 'the existing data-level centroid/ring snap remains');
});

// ── Renderer-throw rollback: no phantom mark, no permanent governor hold ──────
//
// The engine holds continuous render for exactly as long as a mark is live
// (annotations.size > 0). A renderer/WebGL throw that leaves an entry in the
// map therefore leaks a hold that NOTHING releases short of an explicit clear —
// the idle governor is defeated for the rest of the session. The fresh path has
// always guarded this; the duplicate-REPLACEMENT path did the renderer swap
// outside the guard. (perf rebase 2026-08-17)

function throwingRendererHarness() {
  const calls = { add: 0, remove: 0 };
  let failNextAdd = false;
  return {
    calls,
    failAddOnce() { failNextAdd = true; },
    renderer: {
      add() {
        calls.add += 1;
        if (failNextAdd) { failNextAdd = false; throw new Error('WebGL context lost'); }
      },
      update() {},
      remove() { calls.remove += 1; },
      sync() {},
    },
  };
}

const FIXED_POINT = { lon: -97.7431, lat: 30.2672, height: 0 };

test('duplicate-replacement: a renderer throw leaves no phantom mark and no leaked hold', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce } = throwingRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  const first = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(first.drawn, 1);
  assert.equal(engine.list().length, 1);
  assert.ok(
    getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a live mark must hold continuous render',
  );

  // Same place, same caption, NEW colour → the duplicate-REPLACEMENT branch,
  // which deletes the dup and inserts the replacement before touching the
  // renderer. (A bare point dedupes on LABEL — two different captions at one
  // spot are deliberately two marks — so a recolour is the way into this
  // branch for a point; see findDuplicate.)
  failAddOnce();
  const second = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);

  assert.equal(second.drawn, 0, 'the failed swap is reported as a failure, not a draw');
  assert.equal(second.failed, 1);
  assert.equal(engine.list().length, 0, 'no phantom annotation survives the failed swap');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'the annotations hold must be released — a leak defeats the idle governor permanently',
  );
});

test('fresh path: a renderer throw is rolled back the same way', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce } = throwingRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  failAddOnce();
  const result = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);

  assert.equal(result.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation from a failed first add');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a never-rendered mark must not hold continuous render',
  );
});

// ── Rollback must also unwind PARTIAL renderer state (second review) ──────────
//
// The harness above throws on the FIRST statement of add(), so a rollback that
// only deletes the engine's map entry looked complete. The real renderers build
// a mark in stages — the hybrid adds world geometry before it records the route;
// the screen renderer inserts its SVG group before its last projection pass — so
// a throw part-way leaves live content the map rollback cannot reach. The next
// annotate of the same geometry then stacks a fresh mark over that orphan.

/** A renderer that puts the mark on the board BEFORE the step that fails. */
function partialStateRendererHarness() {
  const live = new Map(); // stands in for world entities / SVG groups
  let failNextAdd = false;
  return {
    live,
    failAddOnce() { failNextAdd = true; },
    renderer: {
      add(anno) {
        live.set(anno.id, anno); // partial renderer state exists NOW
        if (failNextAdd) { failNextAdd = false; throw new Error('WebGL context lost'); }
      },
      update() {},
      remove(anno) { live.delete(anno.id); },
      sync() {},
    },
  };
}

test('fresh path: a throw AFTER partial renderer state leaves nothing on the board', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce, live } = partialStateRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  failAddOnce();
  const failed = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(failed.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation');
  assert.equal(live.size, 0, 'the rollback must release what the renderer had already created');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'a never-rendered mark must not hold continuous render',
  );

  // The real cost of an orphan: re-annotating the same place stacks a second
  // mark on top of the one nothing owns.
  const retry = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(retry.drawn, 1);
  assert.equal(live.size, 1, 'a re-annotate must draw ONE mark, not stack over an orphan');
});

test('duplicate-replacement: a throw AFTER partial renderer state leaves nothing on the board', async (t) => {
  installAnimationFrameStubs(t);
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());

  const { renderer, failAddOnce, live } = partialStateRendererHarness();
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async () => ({ ...FIXED_POINT }),
  });

  const first = await engine.annotate([{ type: 'point', target: 'Texas Capitol', label: 'Capitol' }]);
  assert.equal(first.drawn, 1);
  assert.equal(live.size, 1);

  // Recolour → the duplicate-REPLACEMENT swap: remove(dup) lands, add(anno)
  // creates its state and then throws.
  failAddOnce();
  const swap = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);
  assert.equal(swap.drawn, 0);
  assert.equal(engine.list().length, 0, 'no phantom annotation survives the failed swap');
  assert.equal(live.size, 0, 'and no half-swapped mark survives on the board');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('annotations'),
    'the annotations hold must be released',
  );

  const retry = await engine.annotate([
    { type: 'point', target: 'Texas Capitol', label: 'Capitol', color: 'amber' },
  ]);
  assert.equal(retry.drawn, 1);
  assert.equal(live.size, 1, 'the recoloured mark redraws once, with no orphan underneath');
});
