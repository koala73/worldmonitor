import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOCATION_ELASTIC,
  ALLOCATION_WEIGHTED,
  LabelArbiter,
  allocateLayerQuotas,
} from './labelArbiter.js';

function objectQuotas(map) {
  return Object.fromEntries(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function candidate(layerId, index, x = index * 30) {
  return {
    key: `${layerId}:${index}`,
    layerId,
    sourceId: index,
    priority: 0,
    centerDistance: Math.abs(x),
    keyholeAlpha: 1,
    placements: [{ corner: 'NE', rect: { x, y: layerId === 'flights' ? 0 : 80, w: 20, h: 12 } }],
  };
}

function spatialCandidate(index, x, y) {
  return {
    key: `satellites:${index}`,
    layerId: 'satellites',
    priority: 25,
    centerDistance: Math.hypot(x, y),
    keyholeAlpha: 1,
    screenX: x,
    screenY: y,
    placements: [{ corner: 'NE', rect: { x: x * 2, y: y * 2, w: 10, h: 8 } }],
  };
}

test('Elastic gives one layer full capacity and two layers an equal entitlement', () => {
  assert.deepEqual(objectQuotas(allocateLayerQuotas({ cctv: 200 }, 90, ALLOCATION_ELASTIC)), { cctv: 90 });
  assert.deepEqual(
    objectQuotas(allocateLayerQuotas({ cctv: 200, traffic: 200 }, 90, ALLOCATION_ELASTIC)),
    { cctv: 45, traffic: 45 },
  );
});

test('Elastic redistributes unused capacity', () => {
  assert.deepEqual(
    objectQuotas(allocateLayerQuotas({ cctv: 200, traffic: 20 }, 90, ALLOCATION_ELASTIC)),
    { cctv: 70, traffic: 20 },
  );
});

test('Weighted is deterministic, representative, and work-conserving', () => {
  const first = allocateLayerQuotas({ flights: 1000, satellites: 100 }, 28, ALLOCATION_WEIGHTED);
  const reverse = allocateLayerQuotas(new Map([['satellites', 100], ['flights', 1000]]), 28, ALLOCATION_WEIGHTED);
  assert.deepEqual(objectQuotas(first), objectQuotas(reverse));
  assert.equal(Array.from(first.values()).reduce((sum, value) => sum + value, 0), 28);
  assert.ok(first.get('flights') > 0);
  assert.ok(first.get('satellites') > 0);
  assert.ok(first.get('flights') > first.get('satellites'));
});

test('arbiter is registration-order independent and represents both layers', () => {
  const objects = [
    ...Array.from({ length: 20 }, (_, index) => candidate('flights', index)),
    ...Array.from({ length: 20 }, (_, index) => candidate('satellites', index)),
  ];
  const a = new LabelArbiter();
  const b = new LabelArbiter();
  a.solve(objects, { capacity: 10, strategy: ALLOCATION_ELASTIC, now: 1000 });
  b.solve(objects.slice().reverse(), { capacity: 10, strategy: ALLOCATION_ELASTIC, now: 1000 });
  assert.deepEqual(Array.from(a.selectedKeys).sort(), Array.from(b.selectedKeys).sort());
  assert.equal(a.diagnostics().labelsByLayer.flights, 5);
  assert.equal(a.diagnostics().labelsByLayer.satellites, 5);
});

test('unchanged solves and policy toggles preserve winning identities', () => {
  const objects = [
    ...Array.from({ length: 12 }, (_, index) => candidate('flights', index)),
    ...Array.from({ length: 6 }, (_, index) => candidate('satellites', index)),
  ];
  const arbiter = new LabelArbiter();
  arbiter.solve(objects, { capacity: 8, strategy: ALLOCATION_ELASTIC, now: 1000 });
  const first = new Set(arbiter.selectedKeys);
  arbiter.solve(objects, { capacity: 8, strategy: ALLOCATION_ELASTIC, now: 1125 });
  assert.deepEqual(arbiter.selectedKeys, first);
  arbiter.solve(objects, { capacity: 8, strategy: ALLOCATION_WEIGHTED, now: 1250 });
  const retained = Array.from(first).filter((key) => arbiter.selectedKeys.has(key));
  assert.ok(retained.length >= 6);
});

test('incumbents satisfying the layer target skip spatial queue construction', () => {
  const objects = Array.from({ length: 12 }, (_, index) => candidate('flights', index));
  const arbiter = new LabelArbiter();
  arbiter.solve(objects, { capacity: 6, strategy: ALLOCATION_ELASTIC, now: 1000 });
  assert.ok(arbiter.diagnostics().spatialQueueBuildCount > 0);

  arbiter.solve(objects, {
    capacity: 6,
    strategy: ALLOCATION_ELASTIC,
    now: 1125,
    preserveIncumbents: true,
  });
  assert.equal(arbiter.diagnostics().spatialQueueBuildCount, 0);
});

test('candidate anchors are cached once as scalar coordinates for queue scans', () => {
  const objects = [candidate('flights', 1, 40), candidate('flights', 2, 100)];
  const arbiter = new LabelArbiter();
  arbiter.solve(objects, { capacity: 1, strategy: ALLOCATION_ELASTIC, now: 1000 });
  assert.deepEqual(
    objects.map((item) => [item._anchorX, item._anchorY]),
    [[50, 6], [110, 6]],
  );
});

test('increasing capacity retains the entire eligible cohort', () => {
  const objects = [
    ...Array.from({ length: 30 }, (_, index) => candidate('flights', index)),
    ...Array.from({ length: 30 }, (_, index) => candidate('satellites', index)),
  ];
  const arbiter = new LabelArbiter();
  let previous = new Set();
  for (const [capacity, now] of [[14, 1000], [21, 1125], [28, 1250]]) {
    arbiter.solve(objects, {
      capacity,
      strategy: ALLOCATION_ELASTIC,
      now,
      preserveIncumbents: true,
    });
    for (const key of previous) assert.ok(arbiter.selectedKeys.has(key));
    previous = new Set(arbiter.selectedKeys);
  }
});

test('collision placement never accepts overlapping cards', () => {
  const objects = Array.from({ length: 5 }, (_, index) => ({
    ...candidate('cctv', index, 0),
    placements: [{ corner: 'NE', rect: { x: 0, y: 0, w: 50, h: 20 } }],
  }));
  const arbiter = new LabelArbiter();
  const result = arbiter.solve(objects, { capacity: 5, strategy: ALLOCATION_ELASTIC, now: 1000 });
  assert.equal(result.selectedCount, 1);
});

test('saturated vertical-only candidates are dismissed without repeated spread-queue revisits', () => {
  const objects = Array.from({ length: 18 }, (_, index) => ({
    key: `firms:${index}`,
    layerId: 'firms',
    sourceId: index,
    priority: 18 - index,
    centerDistance: index,
    keyholeAlpha: 1,
    screenX: 100,
    screenY: 100,
    placements: [
      { corner: 'above', rect: { x: 60, y: 50, w: 80, h: 30 } },
      { corner: 'below', rect: { x: 60, y: 120, w: 80, h: 30 } },
    ],
  }));
  const arbiter = new LabelArbiter();
  const result = arbiter.solve(objects, {
    capacity: objects.length,
    demandByLayer: { firms: objects.length },
    now: 1000,
    preserveIncumbents: false,
  });
  assert.equal(result.selectedCount, 2);
  assert.ok(result.spatialQueueNextCount <= 4, `next() calls: ${result.spatialQueueNextCount}`);
});

test('first equal-priority solve distributes labels across the candidate field', () => {
  const objects = [
    spatialCandidate('center', 0, 0),
    spatialCandidate('nw', -100, -100),
    spatialCandidate('ne', 100, -100),
    spatialCandidate('sw', -100, 100),
    spatialCandidate('se', 100, 100),
    spatialCandidate('near-1', -10, -10),
    spatialCandidate('near-2', 10, -10),
    spatialCandidate('near-3', -10, 10),
    spatialCandidate('near-4', 10, 10),
  ];
  const arbiter = new LabelArbiter();
  arbiter.solve(objects, { capacity: 4, strategy: ALLOCATION_ELASTIC, now: 1000 });
  const selected = objects.filter((item) => arbiter.selectedKeys.has(item.key));
  const outerCount = selected.filter((item) => item.centerDistance > 100).length;
  const xValues = selected.map((item) => item.screenX);
  const yValues = selected.map((item) => item.screenY);
  assert.ok(outerCount >= 3);
  assert.ok(Math.max(...xValues) - Math.min(...xValues) >= 200);
  assert.ok(Math.max(...yValues) - Math.min(...yValues) >= 200);
});

test('semantic priority outranks spatial separation for new labels', () => {
  const highPriority = { ...spatialCandidate('priority', 0, 0), priority: 120 };
  const farCandidate = spatialCandidate('far', 500, 500);
  const arbiter = new LabelArbiter();
  arbiter.solve([farCandidate, highPriority], { capacity: 1, strategy: ALLOCATION_ELASTIC, now: 1000 });
  assert.deepEqual(arbiter.selectedKeys, new Set([highPriority.key]));
});

test('fading entries remain renderable for the transition window', () => {
  const arbiter = new LabelArbiter();
  const one = [candidate('flights', 1)];
  arbiter.solve(one, { capacity: 1, now: 1000 });
  const pooled = [{}];
  const rendered = arbiter.renderEntries(one, 1150, pooled);
  assert.equal(rendered, pooled);
  assert.equal(rendered[0], pooled[0]);
  assert.equal(rendered[0].temporalAlpha, 1);
  arbiter.solve([], { capacity: 0, now: 1200 });
  assert.ok(arbiter.renderEntries([], 1300)[0].temporalAlpha > 0);
  assert.equal(arbiter.renderEntries([], 1501).length, 0);
});

test('renderEntries reuses output without filter, slice, or sort allocation helpers', () => {
  const arbiter = new LabelArbiter();
  const objects = [candidate('flights', 1), candidate('flights', 2, 80)];
  arbiter.solve(objects, { capacity: 2, now: 1000 });
  const current = new Map(objects.map((item) => [item.key, item]));
  const pooled = [{}, {}];
  const originals = {
    filter: Array.prototype.filter,
    slice: Array.prototype.slice,
    sort: Array.prototype.sort,
  };
  const calls = { filter: 0, slice: 0, sort: 0 };
  for (const name of Object.keys(originals)) {
    Array.prototype[name] = function countRenderAllocationHelper(...args) {
      calls[name]++;
      return originals[name].apply(this, args);
    };
  }
  let rendered;
  try {
    rendered = arbiter.renderEntries(current, 1200, pooled);
  } finally {
    Object.assign(Array.prototype, originals);
  }
  assert.equal(rendered, pooled);
  assert.equal(rendered[0], pooled[0]);
  assert.equal(rendered[1], pooled[1]);
  assert.deepEqual(calls, { filter: 0, slice: 0, sort: 0 });
});

test('moving cohorts re-solve with cohort-independent allocation helpers', () => {
  const movingCohort = (size, frame) => Array.from({ length: size }, (_, index) => {
    const x = ((index * 37 + frame * 3) % 700) + 10;
    const y = ((index * 53 + frame * 5) % 500) + 10;
    return {
      key: `flights:${index}`,
      layerId: 'flights',
      sourceId: index,
      priority: index % 4,
      centerDistance: Math.hypot(x - 350, y - 250),
      keyholeAlpha: 1,
      screenX: x,
      screenY: y,
      placements: [
        { corner: 'above', rect: { x, y, w: 48, h: 16 } },
        { corner: 'below', rect: { x, y: y + 24, w: 48, h: 16 } },
      ],
    };
  });

  const originals = {
    filter: Array.prototype.filter,
    slice: Array.prototype.slice,
    sort: Array.prototype.sort,
    push: Array.prototype.push,
  };
  const measure = (size) => {
    const arbiter = new LabelArbiter();
    for (let frame = 0; frame < 6; frame++) {
      arbiter.solve(movingCohort(size, frame), { capacity: size, now: 1000 + frame * 130 });
    }
    const calls = { filter: 0, slice: 0, sort: 0, push: 0 };
    for (const name of Object.keys(originals)) {
      Array.prototype[name] = function countSolveAllocationHelper(...args) {
        calls[name]++;
        return originals[name].apply(this, args);
      };
    }
    try {
      arbiter.solve(movingCohort(size, 6), { capacity: size, now: 1780 });
    } finally {
      Object.assign(Array.prototype, originals);
    }
    return calls;
  };

  const small = measure(12);
  const large = measure(60);
  // The remaining helpers are layer-scale (quota allocation), so a five-fold
  // larger cohort must not add a single per-candidate array operation.
  assert.deepEqual(large, small);
  assert.ok(small.slice + small.push === 0);
});

test('selected-key membership is republished in place across solves', () => {
  const arbiter = new LabelArbiter();
  const objects = Array.from({ length: 6 }, (_, index) => candidate('flights', index));
  arbiter.solve(objects, { capacity: 4, now: 1000 });
  const keys = arbiter.selectedKeys;
  const first = new Set(keys);
  arbiter.solve(objects.slice(0, 3), { capacity: 2, now: 1400 });
  assert.equal(arbiter.selectedKeys, keys);
  assert.equal(keys.size, 2);
  for (const key of keys) assert.ok(objects.slice(0, 3).some((item) => item.key === key));
  assert.ok(first.size > keys.size);
});

test('a stateless candidate keeps no corner, no cooldown, and no fades', () => {
  // Sources that shipped as a per-frame rebuild (CCTV thumbnails) opt out of the
  // arbiter's statefulness. Everything the default path remembers, this path must
  // forget: the sticky corner that pinned cards below their icon mid-screen, the
  // 1.5 s re-entry cooldown that delayed their return after a sweep, and the
  // enter/exit ramps that a hard-cliff source never had.
  const make = (key, overrides = {}) => ({
    key,
    layerId: 'cctv',
    sourceId: key,
    priority: 1,
    centerDistance: 0,
    keyholeAlpha: 1,
    screenX: 130,
    screenY: 110,
    stateless: true,
    placements: [
      { corner: 'above', rect: { x: 100, y: 100, w: 60, h: 20 } },
      { corner: 'below', rect: { x: 100, y: 400, w: 60, h: 20 } },
    ],
    ...overrides,
  });
  const blocker = make('cctv:blocker', {
    priority: 10,
    stateless: false,
    placements: [{ corner: 'above', rect: { x: 100, y: 100, w: 60, h: 20 } }],
  });
  const mover = make('cctv:mover');

  const arbiter = new LabelArbiter();
  arbiter.solve([blocker, mover], { capacity: 2, now: 1000 });
  assert.equal(arbiter.states.get('cctv:mover').corner, 'below',
    'it took the free corner while the preferred one was blocked');

  // Corner is re-decided from geometry, NOT remembered: with the blocker gone the
  // card returns to its preferred placement immediately.
  arbiter.solve([mover], { capacity: 1, now: 1100 });
  assert.equal(arbiter.states.get('cctv:mover').corner, 'above',
    'a stateless candidate re-decides its corner instead of sticking');

  // Evicted, then re-offered on the very next solve: no cooldown may block it.
  arbiter.solve([], { capacity: 0, now: 1200 });
  assert.equal(arbiter.states.get('cctv:mover').cooldownUntil, 0,
    'eviction stamps no re-entry cooldown on a stateless candidate');
  arbiter.solve([mover], { capacity: 1, now: 1220 });
  const rendered = arbiter.renderEntries(new Map([[mover.key, mover]]), 1220, []);
  const entry = rendered.find((item) => item.candidate.key === 'cctv:mover');
  assert.ok(entry, 'the card returns on the next solve rather than waiting out a cooldown');
  assert.equal(entry.temporalAlpha, 1,
    'it paints at full alpha on arrival — a hard cliff, not a 150 ms ramp');

  // And it leaves on a cliff too, with no fade-out tail.
  arbiter.solve([], { capacity: 0, now: 1300 });
  const afterExit = arbiter.renderEntries(new Map(), 1310, []);
  assert.equal(afterExit.find((item) => item.candidate.key === 'cctv:mover'), undefined,
    'a stateless card disappears on eviction instead of fading out');
});

test('a re-solve retries the remembered corner before the first listed placement', () => {
  const blocker = {
    key: 'flights:blocker',
    layerId: 'flights',
    sourceId: 'blocker',
    priority: 10,
    centerDistance: 0,
    keyholeAlpha: 1,
    screenX: 130,
    screenY: 110,
    placements: [{ corner: 'above', rect: { x: 100, y: 100, w: 60, h: 20 } }],
  };
  const mover = {
    key: 'flights:mover',
    layerId: 'flights',
    sourceId: 'mover',
    priority: 1,
    centerDistance: 10,
    keyholeAlpha: 1,
    screenX: 130,
    screenY: 110,
    placements: [
      { corner: 'above', rect: { x: 100, y: 100, w: 60, h: 20 } },
      { corner: 'below', rect: { x: 100, y: 400, w: 60, h: 20 } },
    ],
  };
  const arbiter = new LabelArbiter();
  arbiter.solve([blocker, mover], { capacity: 2, now: 1000 });
  assert.equal(arbiter.states.get('flights:mover').corner, 'below');

  // The blocker is gone, so the first listed placement is free again. Sticky
  // corners are tried FIRST regardless of list order, otherwise a label hops
  // back and forth every time its neighbour comes and goes.
  arbiter.solve([mover], { capacity: 1, now: 4000 });
  assert.equal(arbiter.states.get('flights:mover').corner, 'below');
});

test('candidate ordering is stable when the comparator reports a true tie', () => {
  // Canonically equivalent but distinct strings collate to 0, which is the only
  // way candidateCompare ties two different identities all the way down.
  const tied = (key, x) => ({
    key,
    layerId: 'flights',
    sourceId: key,
    priority: 3,
    centerDistance: 42,
    keyholeAlpha: 1,
    screenX: x,
    screenY: 0,
    placements: [{ corner: 'above', rect: { x, y: 0, w: 20, h: 12 } }],
  });
  const first = tied('flights:é', 0);
  const second = tied('flights:é', 400);
  assert.equal(first.key.localeCompare(second.key), 0);
  assert.notEqual(first.key, second.key);

  const arbiter = new LabelArbiter();
  arbiter.solve([first, second], { capacity: 1, now: 1000 });
  assert.deepEqual(Array.from(arbiter.selectedKeys), [first.key]);

  const reversed = new LabelArbiter();
  reversed.solve([second, first], { capacity: 1, now: 1000 });
  assert.deepEqual(Array.from(reversed.selectedKeys), [second.key]);
});

test('each solve starts from an empty collision field', () => {
  const cohort = Array.from({ length: 5 }, (_, index) => candidate('flights', index, index * 200));
  const arbiter = new LabelArbiter();
  const first = arbiter.solve(cohort, { capacity: 5, now: 1000, preserveIncumbents: false });
  assert.equal(first.selectedCount, 5);
  // Identical geometry one solve later: the reused spatial hash must not still
  // be holding the previous solve's rectangles.
  const second = arbiter.solve(cohort, { capacity: 5, now: 5000, preserveIncumbents: false });
  assert.equal(second.selectedCount, 5);
});

test('the pooled state list is never handed out to callers', () => {
  const arbiter = new LabelArbiter();
  arbiter.solve([candidate('flights', 1), candidate('flights', 2, 200)], { capacity: 2, now: 1000 });
  assert.equal(arbiter.activeStateCount(), 2);
  assert.equal(typeof arbiter.activeStates, 'undefined');
  const state = arbiter.activeStateAt(0);
  assert.ok(state?.key);
  assert.equal(arbiter.activeStateAt(99), undefined);
  // Reading twice must not disturb the arbiter's own view of its states.
  assert.equal(arbiter.activeStateCount(), arbiter.states.size);
});

test('the pooled state list is invalidated when states are dropped', () => {
  const arbiter = new LabelArbiter();
  arbiter.solve([candidate('flights', 1)], { capacity: 1, now: 1000 });
  assert.equal(arbiter.activeStateCount(), 1);
  assert.equal(arbiter.activeStateCount(), arbiter.states.size);

  arbiter.solve([], { capacity: 0, now: 1200 });
  assert.equal(arbiter.activeStateCount(), arbiter.states.size);

  arbiter.solve([], { capacity: 0, now: 5000 });
  assert.equal(arbiter.states.size, 0);
  assert.equal(arbiter.activeStateCount(), 0);
});

test('uncapped demand drives quotas while the solve input remains bounded', () => {
  const objects = [
    ...Array.from({ length: 12 }, (_, index) => candidate('flights', index)),
    ...Array.from({ length: 12 }, (_, index) => candidate('satellites', index, 500 + index * 30)),
  ];
  const arbiter = new LabelArbiter();
  arbiter.solve(objects, {
    capacity: 20,
    strategy: ALLOCATION_WEIGHTED,
    demandByLayer: { flights: 12000, satellites: 120 },
    now: 1000,
  });
  const diagnostics = arbiter.diagnostics();
  assert.deepEqual(diagnostics.demand, { flights: 12000, satellites: 120 });
  assert.ok(diagnostics.quotas.flights > diagnostics.quotas.satellites);
  assert.equal(diagnostics.capacity, 20);
});

test('live identities expose selected and temporal fading membership by layer/source', () => {
  const arbiter = new LabelArbiter();
  const one = [candidate('flights', 42)];
  arbiter.solve(one, { capacity: 1, now: 1000 });
  assert.deepEqual(arbiter.liveIdentities({ includeFading: false, now: 1100 }), new Map([
    ['flights', new Set([42])],
  ]));
  arbiter.solve([], { capacity: 0, now: 1200 });
  assert.equal(arbiter.liveIdentities({ includeFading: false, now: 1250 }).size, 0);
  assert.deepEqual(arbiter.liveIdentities({ includeFading: true, now: 1250 }), new Map([
    ['flights', new Set([42])],
  ]));
  assert.equal(arbiter.liveIdentities({ includeFading: true, now: 1501 }).size, 0);
});
