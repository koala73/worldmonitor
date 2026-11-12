import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSummary,
  DISCOVERY_ALERT_RUNS,
  MAX_ATL06_GRANULES_PER_RUN,
  MAX_GRANULE_FAILURES,
  MAX_GRANULES_PER_RUN,
  STATE_SCHEMA,
  buildSeedOptions,
  countWithLatest,
  fetchReservoirLevels,
  granuleGroups,
  makeValidate,
  mergeReservoirState,
  mergeState,
  planFetches,
  stripState,
  withRevisions,
} from '../scripts/seed-reservoir-levels.mjs';
import { atl13FileRecords, csvFileRecords, csvFromAtl06Rows, exceptRecord, eventRecord, streamResponse } from './helpers/sliderule-stream.mjs';

const NOW = Date.parse('2026-11-11T00:00:00Z');
const DAY = 86_400_000;

const WATCHLIST = [
  { id: 'alpha', name: 'Alpha', country: 'XA', riparians: ['XA'], river: 'A', lat: 1, lon: 1, core: [0.9, 0.9, 1.1, 1.1], refid: 11, tags: ['hydropower'], why: 'a' },
  { id: 'beta', name: 'Beta', country: 'XB', riparians: ['XB'], river: 'B', lat: 2, lon: 2, core: [1.9, 1.9, 2.1, 2.1], tags: ['canal'], why: 'b' },
];

const gran = (date, rgt, rev = '01') => `ATL13_${date.replaceAll('-', '')}120000_${String(rgt).padStart(4, '0')}3101_007_${rev}.h5`;

function tuple(date, level, rgt = 100) {
  return [`${date}T12:00Z`, rgt, level, 0.03, 40, 0.05];
}

/** Monthly passes from 2019 to the cursor month for one reservoir. */
function history(base, cursorDate) {
  const passes = [];
  for (let t = Date.parse('2019-01-15T12:00:00Z'); t <= Date.parse(`${cursorDate}T12:00:00Z`); t += 30 * DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    passes.push(tuple(d, base + Math.sin(t / (58 * DAY)), 100 + (passes.length % 50)));
  }
  return passes;
}

const BASELINE = {
  generatedAt: '2026-10-01T00:00:00Z',
  through: '2026-08-20',
  reservoirs: {
    alpha: { passes: history(300, '2026-08-20'), processedThrough: '2026-08-20', failedGranules: {} },
    beta: { passes: history(50, '2026-08-10'), processedThrough: '2026-08-10', failedGranules: { [gran('2026-07-01', 7)]: 1 } },
  },
};

/**
 * Fake CMR + SlideRule. cmr: { id -> [granule names] } keyed by core bbox; slide(granules)
 * returns { rows, failGranules, status }.
 */
function fakeUpstream({ cmr = {}, cmrDown = false, cmrDownFor = [], slideDown = false, failGranules = [], emptyGranules = [], level = {}, trackOffset = 0, flownRgt } = {}) {
  const calls = { cmr: 0, slide: [] };
  const byBbox = new Map(WATCHLIST.map((e) => [e.core.join(','), e.id]));
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'cmr.earthdata.nasa.gov') {
      calls.cmr++;
      if (cmrDown) throw new TypeError('fetch failed');
      const id = byBbox.get(u.searchParams.get('bounding_box'));
      if (cmrDownFor.includes(id)) return { ok: false, status: 400, headers: new Headers(), json: async () => ({}), text: async () => 'boom' };
      const since = u.searchParams.get('temporal').split(',')[0].slice(0, 10);
      const entries = (cmr[id] || []).filter((g) => g.slice(6, 14) >= since.replaceAll('-', '')).map((g) => ({ producer_granule_id: g }));
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ feed: { entry: entries } }) };
    }
    if (u.hostname === 'sliderule.slideruleearth.io') {
      const body = JSON.parse(init.body);
      const parms = { ...body.parms, resources: body.resource ? [body.resource] : body.parms.resources };
      calls.slide.push(parms.resources);
      if (slideDown) return streamResponse([Buffer.from('down')], { status: 503, contentType: 'text/plain' });
      const id = WATCHLIST.find((e) => Math.abs(parms.poly[0].lon - e.core[0]) < 1e-9).id;
      const rows = [];
      for (const g of parms.resources) {
        if (failGranules.includes(g) || emptyGranules.includes(g)) continue;
        const date = `${g.slice(6, 10)}-${g.slice(10, 12)}-${g.slice(12, 14)}`;
        const rgt = Number(g.slice(21, 25));
        for (let i = 0; i < 20; i++) rows.push({ t: `${date}T12:00:00Z`, rgt, segmentRgt: flownRgt ?? rgt + trackOffset, gt: [10, 30, 50][i % 3], h: (level[id] ?? 300) + (i % 3) * 0.01, refid: id === 'alpha' ? 11 : 99 });
      }
      const recs = [...atl13FileRecords(rows), eventRecord('generated rows', 1)];
      for (const g of parms.resources.filter((x) => failGranules.includes(x))) recs.push(exceptRecord(`H5Coro::Future read failure on ${g}/gt1l/ht_ortho`));
      return streamResponse(recs);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

const run = (opts) => fetchReservoirLevels({
  nowMs: NOW, baseline: BASELINE, watchlist: WATCHLIST, readState: async () => null, log: () => {}, ...opts,
});

describe('reservoir seeder run', () => {
  it('cold start from the baseline only, with no new granules, is a success with unchanged passes', async () => {
    const { fetchImpl, calls } = fakeUpstream({ cmr: { alpha: [gran('2026-08-20', 5)] } });
    const state = { schema: STATE_SCHEMA, byId: { alpha: { passes: [], cursor: '2026-08-20', processed: [gran('2026-08-20', 5)], failures: {}, gaveUp: [] } } };
    const data = await run({ fetchImpl, readState: async () => state });
    // beta retries its one failed baseline granule; alpha has nothing new.
    assert.deepEqual(calls.slide, [[gran('2026-07-01', 7)]]);
    assert.equal(data.reservoirs.length, 2);
    assert.equal(countWithLatest(data), 2);
    assert.equal(data.reservoirs[0].latest.date, BASELINE.reservoirs.alpha.passes.at(-1)[0].slice(0, 10));
    assert.equal(data._state.byId.alpha.passes.length, BASELINE.reservoirs.alpha.passes.length);
    assert.equal(makeValidate(2)(stripState(data)), true);
    assert.equal('_state' in stripState(data), false);
  });

  it('fetches new granules past the cursor, merges them and advances the cursor', async () => {
    const newer = [gran('2026-09-02', 21), gran('2026-09-15', 22)];
    const { fetchImpl, calls } = fakeUpstream({ cmr: { alpha: [gran('2026-08-12', 4), ...newer] }, level: { alpha: 299.5 } });
    const data = await run({ fetchImpl });
    assert.deepEqual(calls.slide.flat().filter(g => [gran('2026-08-12', 4), ...newer].includes(g)).sort(), [gran('2026-08-12', 4), ...newer]);
    const a = data._state.byId.alpha;
    assert.equal(a.cursor, '2026-09-15');
    assert.ok(a.processed.includes(newer[1]));
    const alpha = data.reservoirs.find((r) => r.id === 'alpha');
    assert.equal(alpha.latest.date, '2026-09-15');
    assert.ok(Math.abs(alpha.latest.levelM - 299.51) < 0.02);
  });

  it('filters rows to the configured ATL13 water body', async () => {
    const { fetchImpl } = fakeUpstream({ cmr: { beta: [gran('2026-09-01', 30)] }, level: { beta: 50.2 } });
    const data = await run({ fetchImpl, watchlist: [WATCHLIST[0], { ...WATCHLIST[1], refid: 12345 }] });
    // beta's rows carry refid 99, so nothing survives the filter, yet the granule is processed.
    const b = data._state.byId.beta;
    assert.ok(b.processed.includes(gran('2026-09-01', 30)));
    assert.equal(data.reservoirs[1].latest.date, BASELINE.reservoirs.beta.passes.at(-1)[0].slice(0, 10));
  });

  it('records a per-granule failure, keeps the rest of the batch, and gives up after three failed runs', async () => {
    const bad = gran('2026-09-05', 40);
    const good = gran('2026-09-09', 41);
    const { fetchImpl } = fakeUpstream({ cmr: { alpha: [bad, good] }, failGranules: [bad] });
    let state = null;
    for (let i = 1; i <= MAX_GRANULE_FAILURES; i++) {
      const data = await run({ fetchImpl, readState: async () => state });
      state = data._state;
      const a = state.byId.alpha;
      assert.ok(a.processed.includes(good));
      if (i < MAX_GRANULE_FAILURES) assert.equal(a.failures[bad], i);
    }
    assert.equal(state.byId.alpha.failures[bad], undefined);
    assert.ok(state.byId.alpha.gaveUp.includes(bad));
    // After giving up, the granule is no longer requested.
    const again = fakeUpstream({ cmr: { alpha: [bad, good] } });
    await run({ fetchImpl: again.fetchImpl, readState: async () => state });
    assert.ok(!again.calls.slide.flat().includes(bad));
  });

  it('re-processing the same granules leaves the state unchanged (idempotent merge)', async () => {
    const g = [gran('2026-09-02', 21)];
    const first = await run(fakeUpstream({ cmr: { alpha: g } }));
    const reset = { ...first._state, byId: { ...first._state.byId, alpha: { ...first._state.byId.alpha, processed: [] } } };
    const second = await run({ ...fakeUpstream({ cmr: { alpha: g } }), readState: async () => reset });
    assert.deepEqual(second._state.byId.alpha.passes, first._state.byId.alpha.passes);
    assert.deepEqual(stripState(second), stripState(first));
  });

  it('a total CMR outage throws a non-retryable preservable failure without touching SlideRule', async () => {
    const { fetchImpl, calls } = fakeUpstream({ cmrDown: true });
    await assert.rejects(run({ fetchImpl }), (err) => err.preservableFetchFailure === true && err.nonRetryable === true && /CMR unreachable/.test(err.message));
    assert.equal(calls.slide.length, 0);
    assert.ok(calls.cmr <= 3, `probe stops after the first reservoir, made ${calls.cmr} CMR calls`);
  });

  it('a total SlideRule outage throws instead of publishing', async () => {
    const { fetchImpl } = fakeUpstream({ cmr: { alpha: [gran('2026-09-02', 21)] }, slideDown: true });
    await assert.rejects(run({ fetchImpl }), (err) => err.preservableFetchFailure === true && /SlideRule failed for all \d+ requests/.test(err.message));
  });

  it('planned work that never started (deadline spent in discovery) keeps last-good instead of publishing', async () => {
    const { fetchImpl, calls } = fakeUpstream({ cmr: { alpha: [gran('2026-09-02', 21)] } });
    await assert.rejects(
      run({ fetchImpl, deadlineAtMs: Date.now() - 1 }),
      (err) => err.preservableFetchFailure === true && /no SlideRule request started/.test(err.message),
    );
    assert.equal(calls.slide.length, 0);
  });

  it('finds a granule published late for an acquisition date well before the cursor', async () => {
    // Cursor is 2026-08-20 for alpha. A granule acquired 2026-07-25 that NASA publishes only
    // now must still be discovered and processed.
    const late = gran('2026-07-25', 33);
    const { fetchImpl } = fakeUpstream({ cmr: { alpha: [late] } });
    const data = await run({ fetchImpl });
    assert.ok(data._state.byId.alpha.processed.includes(late), 'late granule processed');
    assert.ok(data._state.byId.alpha.passes.some((t) => String(t[0]).startsWith('2026-07-25') && t[1] === 33), 'late pass merged');
  });

  it('a reprocessed granule revision replaces the earlier measurement of the same pass', async () => {
    const r1 = gran('2026-09-02', 21, '01');
    const r2 = gran('2026-09-02', 21, '02');
    const first = await run({ fetchImpl: fakeUpstream({ cmr: { alpha: [r1] }, level: { alpha: 300 } }).fetchImpl });
    const state = first._state;
    // Revision 02 corrects the height upward with the same segment count, which the old
    // segments-then-lower-height rule would have discarded.
    const second = await run({ fetchImpl: fakeUpstream({ cmr: { alpha: [r1, r2] }, level: { alpha: 301.5 } }).fetchImpl, readState: async () => state });
    const pass = second._state.byId.alpha.passes.find((t) => String(t[0]).startsWith('2026-09-02') && t[1] === 21);
    assert.ok(Math.abs(pass[2] - 301.51) < 0.02, `expected the revision 02 height, got ${pass[2]}`);
  });

  it('replaces an offset-track pass by source granule revision without duplicating its flown key', async () => {
    const r1 = gran('2026-09-02', 21, '01');
    const r2 = gran('2026-09-02', 21, '02');
    const first = await run({ fetchImpl: fakeUpstream({ cmr: { alpha: [r1] }, trackOffset: 2 }).fetchImpl });
    const second = await run({ fetchImpl: fakeUpstream({ cmr: { alpha: [r2] }, trackOffset: 2, level: { alpha: 301.5 } }).fetchImpl, readState: async () => first._state });
    const passes = second._state.byId.alpha.passes.filter(t => t[0].startsWith('2026-09-02'));
    assert.equal(passes.length, 1);
    assert.equal(passes[0][1], 23);
    assert.equal(passes[0][6], 2);
    assert.ok(Math.abs(passes[0][2] - 301.51) < 0.02);
  });

  it('propagates a Redis read failure instead of treating it as a cold start', async () => {
    const { fetchImpl } = fakeUpstream();
    await assert.rejects(run({ fetchImpl, readState: async () => { throw new Error('Redis GET failed: HTTP 500'); } }), /HTTP 500/);
  });

  it('applies the newer revision from every source granule contributing to one flown pass', async () => {
    const baseline = structuredClone(BASELINE);
    const older = tuple('2026-09-02', 300, 23);
    older[4] = 100;
    baseline.reservoirs.alpha.passes.push(older);
    baseline.reservoirs.alpha.processedThrough = '2026-09-02';
    const granules = [gran('2026-09-02', 21, '01'), gran('2026-09-02', 22, '02')];
    const { fetchImpl } = fakeUpstream({ cmr: { alpha: granules }, flownRgt: 23, level: { alpha: 301.5 } });
    const data = await run({ baseline, fetchImpl });
    const passes = data._state.byId.alpha.passes.filter(t => t[0].startsWith('2026-09-02') && t[1] === 23);
    assert.equal(passes.length, 1);
    assert.equal(passes[0][6], 3);
    assert.equal(passes[0][4], 40);
    assert.ok(Math.abs(passes[0][2] - 301.51) < 0.02);
  });

  it('reloads a processed companion when another source orbit is revised below the maximum revision', async () => {
    const a1 = gran('2026-09-02', 21);
    const a2 = gran('2026-09-02', 21, '02');
    const b3 = gran('2026-09-02', 22, '03');
    const first = await run({ ...fakeUpstream({ cmr: { alpha: [a1, b3] }, flownRgt: 23 }) });
    const next = fakeUpstream({ cmr: { alpha: [a2, b3] }, flownRgt: 23, level: { alpha: 301.5 } });
    const second = await run({ ...next, readState: async () => first._state });
    assert.deepEqual(next.calls.slide.flat(), [a2, b3]);
    const pass = second._state.byId.alpha.passes.find(t => t[0].startsWith('2026-09-02') && t[1] === 23);
    assert.equal(pass[4], 40, 'both granules contribute');
    assert.equal(pass[6], 5, 'sum advances even though maximum revision remains 3');
    assert.ok(Math.abs(pass[2] - 301.51) < 0.02, 'corrected reduction supersedes the stored pass');
  });

  it('retains a complete pass if a companion fails, then retries the entire group', async () => {
    const a1 = gran('2026-09-02', 21);
    const a2 = gran('2026-09-02', 21, '02');
    const b1 = gran('2026-09-02', 22);
    const first = await run({ ...fakeUpstream({ cmr: { alpha: [a1, b1] }, flownRgt: 23 }) });
    const failed = await run({ ...fakeUpstream({ cmr: { alpha: [a2, b1] }, flownRgt: 23, failGranules: [b1], level: { alpha: 302 } }), readState: async () => first._state });
    assert.deepEqual(failed._state.byId.alpha.passes, first._state.byId.alpha.passes);
    assert.ok(failed._state.byId.alpha.processed.includes(a2));
    assert.equal(failed._state.byId.alpha.failures[a2], undefined, 'successful fetch is not charged for a companion failure');
    assert.equal(failed._state.byId.alpha.failures[b1], 1);
    const retry = fakeUpstream({ cmr: { alpha: [a2, b1] }, flownRgt: 23, level: { alpha: 302 } });
    const recovered = await run({ ...retry, readState: async () => failed._state });
    assert.deepEqual(retry.calls.slide.flat(), [a2, b1]);
    assert.equal(recovered._state.byId.alpha.passes.find(t => t[0].startsWith('2026-09-02') && t[1] === 23)[4], 40);
  });

  it('reloads existing contributions when a late companion appears', async () => {
    const a = gran('2026-09-02', 21, '03');
    const b = gran('2026-09-02', 22);
    const first = await run({ ...fakeUpstream({ cmr: { alpha: [a] }, flownRgt: 23 }) });
    const late = fakeUpstream({ cmr: { alpha: [a, b] }, flownRgt: 23, level: { alpha: 301 } });
    const second = await run({ ...late, readState: async () => first._state });
    assert.deepEqual(late.calls.slide.flat(), [a, b]);
    const pass = second._state.byId.alpha.passes.find(t => t[0].startsWith('2026-09-02') && t[1] === 23);
    assert.equal(pass[4], 40);
    assert.equal(pass[6], 4);
  });

  it('loads companions just before the discovery lookback boundary', async () => {
    const baseline = structuredClone(BASELINE);
    baseline.reservoirs.alpha.processedThrough = '2026-09-02';
    const floor = new Date(Date.parse('2026-09-02') - 120 * DAY).toISOString().slice(0, 10);
    const before = new Date(Date.parse(floor) - DAY).toISOString().slice(0, 10);
    baseline.reservoirs.alpha.passes.push(tuple(floor, 300, 23));
    const a = gran(before, 21);
    const b = gran(floor, 22, '02');
    const upstream = fakeUpstream({ cmr: { alpha: [a, b] }, flownRgt: 23 });
    await run({ ...upstream, baseline });
    assert.deepEqual(upstream.calls.slide.flat().filter(g => [a, b].includes(g)), [a, b]);
  });

  it('reopens an abandoned acquisition group when a late member arrives', async () => {
    const a = gran('2026-09-02', 21);
    const b = gran('2026-09-02', 22);
    let state = null;
    for (let i = 0; i < MAX_GRANULE_FAILURES; i++) {
      state = (await run({ ...fakeUpstream({ cmr: { alpha: [a] }, failGranules: [a] }), readState: async () => state }))._state;
    }
    assert.ok(state.byId.alpha.gaveUp.includes(a));
    const blocked = fakeUpstream({ cmr: { alpha: [a, b] }, failGranules: [a], flownRgt: 23 });
    state = (await run({ ...blocked, readState: async () => state }))._state;
    assert.deepEqual(blocked.calls.slide.flat(), [a, b]);
    assert.equal(state.byId.alpha.failures[b], undefined);
    assert.ok(state.byId.alpha.processed.includes(b), 'new member is tracked rather than silently dropped');
    assert.equal(state.byId.alpha.failures[a], 1, 'a late member reopens the failed companion retry allowance');
    assert.ok(!state.byId.alpha.passes.some(t => t[0].startsWith('2026-09-02')), 'never publishes a partial combined pass');
    const upstream = fakeUpstream({ cmr: { alpha: [a, b] }, flownRgt: 23 });
    const recovered = await run({ ...upstream, readState: async () => state });
    assert.deepEqual(upstream.calls.slide.flat().filter(g => [a, b].includes(g)), [a, b]);
    assert.ok(recovered._state.byId.alpha.processed.includes(b));
    assert.ok(!recovered._state.byId.alpha.gaveUp.includes(a));
    assert.equal(recovered._state.byId.alpha.passes.find(t => t[0].startsWith('2026-09-02') && t[1] === 23)[4], 40);
  });

  it('never abandons a healthy companion and recovers when the failed orbit is revised', async () => {
    const a = gran('2026-09-02', 21);
    const b = gran('2026-09-02', 22);
    let state = null;
    for (let i = 0; i < MAX_GRANULE_FAILURES; i++) {
      state = (await run({ ...fakeUpstream({ cmr: { alpha: [a, b] }, failGranules: [a], flownRgt: 23 }), readState: async () => state }))._state;
      assert.ok(state.byId.alpha.processed.includes(b));
      assert.equal(state.byId.alpha.failures[b], undefined);
      assert.ok(!state.byId.alpha.gaveUp.includes(b));
    }
    assert.ok(state.byId.alpha.gaveUp.includes(a));
    const a2 = gran('2026-09-02', 21, '02');
    const upstream = fakeUpstream({ cmr: { alpha: [a2, b] }, flownRgt: 23 });
    const recovered = await run({ ...upstream, readState: async () => state });
    assert.deepEqual(upstream.calls.slide.flat(), [a2, b]);
    assert.equal(recovered._state.byId.alpha.passes.find(t => t[0].startsWith('2026-09-02') && t[1] === 23)[4], 40);
  });

  it('retains retry discovery and companions after the cursor advances beyond their date', async () => {
    const a = gran('2026-05-02', 21);
    const b = gran('2026-05-02', 22);
    const state = { schema: STATE_SCHEMA, byId: { alpha: { cursor: '2026-11-01', failures: { [a]: 1 } } } };
    const upstream = fakeUpstream({ cmr: { alpha: [a, b] }, flownRgt: 23 });
    const data = await run({ ...upstream, readState: async () => state });
    assert.deepEqual(upstream.calls.slide.flat().filter(g => [a, b].includes(g)), [a, b]);
    assert.ok(data._state.byId.alpha.passes.some(t => t[0].startsWith('2026-05-02') && t[1] === 23));
    assert.equal(data._state.byId.alpha.failures[a], undefined);
  });

  it('refreshes pending days even when a known companion chain crosses the listing boundary', async () => {
    const baseline = structuredClone(BASELINE);
    baseline.reservoirs.alpha.processedThrough = '2026-09-02';
    const floor = new Date(Date.parse('2026-09-02') - 120 * DAY).toISOString().slice(0, 10);
    const dateBeforeFloor = days => new Date(Date.parse(floor) - days * DAY).toISOString().slice(0, 10);
    const old = [gran(dateBeforeFloor(3), 21), gran(dateBeforeFloor(1), 22)];
    const next = gran(floor, 23);
    const state = { schema: STATE_SCHEMA, byId: { alpha: { processed: old } } };
    const upstream = fakeUpstream({ cmr: { alpha: [...old, next] } });
    const data = await run({ ...upstream, baseline, readState: async () => state });
    assert.ok(upstream.calls.slide.flat().includes(next));
    assert.ok(data._state.byId.alpha.passes.some(t => t[0].startsWith(floor) && t[1] === 23));
  });

  it('removes revised track keys and empty reductions without resurrecting baseline passes', async () => {
    const baseline = structuredClone(BASELINE);
    baseline.reservoirs.alpha.passes.push(tuple('2026-09-02', 300, 23));
    const g = rev => gran('2026-09-02', 21, rev);
    const first = await run({ baseline, ...fakeUpstream({ cmr: { alpha: [g('01')] }, flownRgt: 23 }) });
    const second = await run({ baseline, ...fakeUpstream({ cmr: { alpha: [g('02')] }, flownRgt: 24 }), readState: async () => first._state });
    const keys = state => state.byId.alpha.passes.filter(t => t[0].startsWith('2026-09-02')).map(t => t[1]);
    assert.deepEqual(keys(second._state), [24]);
    assert.deepEqual(keys({ byId: mergeState(baseline, second._state, WATCHLIST) }), [24]);
    const empty = await run({ baseline, ...fakeUpstream({ cmr: { alpha: [g('03')] }, emptyGranules: [g('03')] }), readState: async () => second._state });
    assert.deepEqual(keys(empty._state), []);
    assert.deepEqual(keys({ byId: mergeState(baseline, empty._state, WATCHLIST) }), []);
    assert.equal(empty._state.byId.alpha.passes.length, BASELINE.reservoirs.alpha.passes.length);
  });

  it('publishes an independent day when an abandoned companion still fails', async () => {
    const a = gran('2026-09-02', 21);
    const b = gran('2026-09-04', 22);
    const state = { schema: STATE_SCHEMA, byId: { alpha: { gaveUp: [a] } } };
    const upstream = fakeUpstream({ cmr: { alpha: [a, b] }, failGranules: [a] });
    const data = await run({ ...upstream, readState: async () => state });
    assert.deepEqual(upstream.calls.slide.flat().filter(g => [a, b].includes(g)), [a, b]);
    assert.ok(data._state.byId.alpha.passes.some(t => t[0].startsWith('2026-09-04') && t[1] === 22));
    assert.ok(!data._state.byId.alpha.passes.some(t => t[0].startsWith('2026-09-02')));
    assert.equal(data._state.byId.alpha.failures[b], undefined);
    assert.ok(data._state.byId.alpha.processed.includes(b));
  });

  it('records a failed group attempt even if another member is deferred', async () => {
    const a = gran('2026-09-02', 21);
    const b = gran('2026-09-02', 22);
    const upstream = fakeUpstream({ cmr: { alpha: [a, b] }, failGranules: [a] });
    const realNow = Date.now;
    let clock = realNow();
    const deadlineAtMs = clock + 100_000;
    try {
      Date.now = () => clock;
      const data = await run({ deadlineAtMs, fetchImpl: async (url, init) => {
        const response = await upstream.fetchImpl(url, init);
        if (String(url).includes('/source/atl13x')) clock = deadlineAtMs + 1;
        return response;
      } });
      assert.equal(data._state.byId.alpha.failures[a], 1);
      assert.equal(data._state.byId.alpha.failures[b], undefined, 'deferred member is not charged for a source failure');
      assert.deepEqual(data._state.byId.alpha.processed, []);
    } finally { Date.now = realNow; }
  });

  it('does not commit a partially fetched date group when the run deadline expires', async () => {
    const a1 = gran('2026-09-02', 21);
    const a2 = gran('2026-09-02', 21, '02');
    const b = gran('2026-09-02', 22);
    const first = await run({ ...fakeUpstream({ cmr: { alpha: [a1, b] }, flownRgt: 23 }) });
    const upstream = fakeUpstream({ cmr: { alpha: [a2, b] }, flownRgt: 23 });
    const realNow = Date.now;
    let clock = realNow();
    const deadlineAtMs = clock + 100_000;
    try {
      Date.now = () => clock;
      const data = await run({
        readState: async () => first._state, deadlineAtMs,
        fetchImpl: async (url, init) => {
          const response = await upstream.fetchImpl(url, init);
          if (String(url).includes('/source/atl13x')) clock = deadlineAtMs + 1;
          return response;
        },
      });
      assert.deepEqual(data._state.byId.alpha.passes, first._state.byId.alpha.passes);
      assert.ok(data._state.byId.alpha.processed.includes(a2));
      assert.ok(!data._state.byId.alpha.processed.includes(b), 'deferred companion remains pending');
      assert.deepEqual(data._state.byId.alpha.failures, {});
      assert.deepEqual(upstream.calls.slide.flat(), [a2]);
    } finally { Date.now = realNow; }
  });
});

describe('planning and state', () => {
  it('orders revisions by the day contributors rather than distant chain members', () => {
    const pass = { date: '2026-09-04', rgt: 23 };
    const earlier = gran('2026-09-01', 20, '50');
    const companion = gran('2026-09-03', 21);
    assert.equal(withRevisions([pass], [earlier, companion, gran('2026-09-04', 22, '02')])[0].revision, 3);
    assert.equal(withRevisions([pass], [companion, gran('2026-09-04', 22, '03')])[0].revision, 4);
  });
  it('merges complete-day deletions commutatively and idempotently', () => {
    const a = { passes: [tuple('2026-09-02', 300)], refreshed: { '2026-09-02': 1 } };
    const b = { passes: [], refreshed: { '2026-09-02': 2 } };
    const merged = mergeReservoirState(a, b);
    assert.deepEqual(merged.passes, []);
    assert.deepEqual(mergeReservoirState(b, a), merged);
    assert.deepEqual(mergeReservoirState(merged, a), merged);
  });
  it('keeps overlapping date groups together across midnight and the remaining budget', () => {
    const a = gran('2026-09-02', 21);
    const b = gran('2026-09-03', 22);
    const c = gran('2026-09-10', 30);
    const groups = granuleGroups({ processed: [a], gaveUp: [], failures: {} }, [a, b, c]);
    assert.deepEqual(groups, [[a, b], [c]]);
    assert.deepEqual([...planFetches(new Map([['a', groups]]), 1).values()], []);
    assert.deepEqual([...planFetches(new Map([['a', groups]]), 2).values()], [[a, b]]);
  });

  it('round-robins the per-run granule budget so no reservoir starves', () => {
    const queues = new Map([['a', ['a1', 'a2', 'a3', 'a4']], ['b', ['b1']], ['c', ['c1', 'c2']]]);
    const plan = planFetches(queues, 5);
    assert.deepEqual(Object.fromEntries(plan), { a: ['a1', 'a2'], b: ['b1'], c: ['c1', 'c2'] });
    assert.equal([...planFetches(queues, 100).values()].flat().length, 7);
  });

  it('merges baseline and Redis state commutatively', () => {
    const a = { passes: [tuple('2026-01-01', 1)], cursor: '2026-01-01', processed: ['g1'], failures: { g2: 1 }, gaveUp: [] };
    const b = { passes: [tuple('2026-02-01', 2)], cursor: '2026-02-01', processed: ['g2'], failures: { g3: 2 }, gaveUp: [] };
    assert.deepEqual(mergeReservoirState(a, b), mergeReservoirState(b, a));
    const m = mergeReservoirState(a, b);
    assert.deepEqual(m.failures, { g3: 2 });
    assert.equal(m.cursor, '2026-02-01');
    assert.deepEqual(mergeReservoirState(m, m), m);
  });

  it('ignores Redis state from another schema and covers every watchlist entry', () => {
    const byId = mergeState(BASELINE, { schema: 999, byId: { alpha: { passes: [], cursor: '2030-01-01' } } }, WATCHLIST);
    assert.equal(byId.alpha.cursor, '2026-08-20');
    assert.deepEqual(Object.keys(byId), ['alpha', 'beta']);
    assert.deepEqual(mergeState(null, null, WATCHLIST).beta.passes, []);
  });

  it('does not merge schema-1 granule keys into the corrected baseline', () => {
    const byId = mergeState(BASELINE, { schema: 1, byId: { alpha: { passes: [tuple('2026-08-20', 999, 999)] } } }, WATCHLIST);
    assert.deepEqual(byId.alpha.passes, BASELINE.reservoirs.alpha.passes);
  });

  it('validation rejects a payload where fewer than 80% of reservoirs have a latest pass', () => {
    const v = makeValidate(10);
    const mk = (n) => ({ reservoirs: Array.from({ length: 10 }, (_, i) => ({ id: String(i), latest: i < n ? { date: 'x' } : null })) });
    assert.equal(v(mk(8)), true);
    assert.equal(v(mk(7)), false);
    assert.equal(v({}), false);
  });

  it('seed options write the state key with the canonical payload stripped of it', () => {
    const o = buildSeedOptions(2);
    assert.equal(o.maxStaleMin, 4320);
    assert.equal(o.extraKeys[0].key, 'climate:reservoir-levels:passes:v1');
    const raw = { reservoirs: [], _state: { schema: 1, byId: { a: {} } } };
    assert.deepEqual(o.extraKeys[0].transform(raw), raw._state);
    assert.deepEqual(o.publishTransform(raw), { reservoirs: [] });
  });

  it('reports a reservoir whose discovery keeps failing and drops it from the health record count', async () => {
    const opts = buildSeedOptions(WATCHLIST.length);
    let state = null;
    let data;
    for (let i = 1; i <= DISCOVERY_ALERT_RUNS; i++) {
      const prev = state;
      data = await run({ ...fakeUpstream({ cmr: { alpha: [gran('2026-08-20', 5)] }, cmrDownFor: ['beta'] }), readState: async () => prev });
      state = data._state;
      assert.equal(state.byId.beta.discoveryFailedRuns, i);
      assert.equal(state.byId.alpha.discoveryFailedRuns ?? 0, 0);
      const published = stripState(data);
      const expectFailing = i >= DISCOVERY_ALERT_RUNS ? ['beta'] : [];
      assert.deepEqual(published.discoveryFailing, expectFailing);
      assert.equal(opts.declareRecords(published), 2 - expectFailing.length);
    }
    // Still publishable: beta keeps its last level and the run is not an outage.
    assert.equal(countWithLatest(stripState(data)), 2);
    // One successful discovery clears the alert.
    const prev = state;
    data = await run({ ...fakeUpstream({ cmr: { alpha: [gran('2026-08-20', 5)] } }), readState: async () => prev });
    assert.equal(data._state.byId.beta.discoveryFailedRuns ?? 0, 0);
    assert.deepEqual(stripState(data).discoveryFailing, []);
    assert.equal(opts.declareRecords(stripState(data)), 2);
  });
});

describe('ATL06 entries in the seeder run', () => {
  const GAMMA = { id: 'gamma', name: 'Gamma', country: 'XC', riparians: ['XC'], river: 'C', lat: 3, lon: 3, core: [2.9, 2.9, 3.1, 3.1], product: 'atl06', tags: ['hydropower'], why: 'c' };
  const watchlist = [WATCHLIST[0], GAMMA];
  const baseline = { ...BASELINE, reservoirs: { alpha: BASELINE.reservoirs.alpha, gamma: { passes: history(800, '2026-08-01'), processedThrough: '2026-08-01', failedGranules: {} } } };
  const gran06 = (date, rgt, rev) => gran(date, rgt, rev).replace('ATL13_', 'ATL06_');

  function fake({ cmr, water = 799.5 }) {
    const calls = { cmr: [], slide: [] };
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.hostname === 'cmr.earthdata.nasa.gov') {
        const id = u.searchParams.get('bounding_box') === GAMMA.core.join(',') ? 'gamma' : 'alpha';
        calls.cmr.push({ id, shortName: u.searchParams.get('short_name') });
        const names = (cmr[id] || []).filter((g) => g.startsWith(`${u.searchParams.get('short_name')}_`));
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ feed: { entry: names.map((g) => ({ producer_granule_id: g })) } }) };
      }
      const body = JSON.parse(init.body);
      const parms = { ...body.parms, resources: body.resource ? [body.resource] : body.parms.resources };
      calls.slide.push({ path: u.pathname, resources: parms.resources });
      const rows = [];
      for (const g of parms.resources) {
        const t = `${g.slice(6, 10)}-${g.slice(10, 12)}-${g.slice(12, 14)}T12:00:00Z`;
        const rgt = Number(g.slice(21, 25));
        if (u.pathname === '/source/atl06x') {
          // Water at 799.5 m among land segments 40-90 m higher and a steep shore.
          for (let i = 0; i < 30; i++) rows.push({ t, rgt, gt: [10, 30, 50][i % 3], h: water + (i % 3) * 0.01 });
          for (let i = 0; i < 60; i++) rows.push({ t, rgt, gt: [10, 30, 50][i % 3], h: 840 + i * 0.8, dx: i % 2 ? 0.2 : 0 });
        } else {
          for (let i = 0; i < 20; i++) rows.push({ t, rgt, gt: [10, 30, 50][i % 3], h: 300, refid: 11 });
        }
      }
      return streamResponse(u.pathname === '/source/atl06x' ? csvFileRecords(csvFromAtl06Rows(rows), 200) : atl13FileRecords(rows));
    };
    return { fetchImpl, calls };
  }

  it('routes ATL06 entries to the ATL06 collection and atl06x, and ATL13 entries unchanged', async () => {
    const { fetchImpl, calls } = fake({ cmr: { alpha: [gran('2026-09-02', 21)], gamma: [gran06('2026-09-03', 33)] } });
    const data = await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => null, log: () => {}, fetchImpl });
    assert.deepEqual(calls.cmr.map((c) => `${c.id}:${c.shortName}`).sort(), ['alpha:ATL13', 'gamma:ATL06']);
    assert.deepEqual(calls.slide.find((c) => c.path === '/source/atl06x').resources, [gran06('2026-09-03', 33)]);
    assert.deepEqual(calls.slide.find((c) => c.path === '/source/atl13x').resources, [gran('2026-09-02', 21)]);
    const gamma = data.reservoirs.find((r) => r.id === 'gamma');
    assert.equal(gamma.latest.date, '2026-09-03');
    assert.ok(Math.abs(gamma.latest.levelM - 799.51) < 0.02, `level ${gamma.latest.levelM}`);
    assert.equal(data._state.byId.gamma.cursor, '2026-09-03');
    assert.equal(data.reservoirs.find((r) => r.id === 'alpha').latest.date, '2026-09-02');
  });

  it('applies the entry level window: a pass with no segment inside it adds nothing', async () => {
    const { fetchImpl } = fake({ cmr: { gamma: [gran06('2026-09-03', 33)] } });
    const windowed = [WATCHLIST[0], { ...GAMMA, levelWindowM: [700, 790] }];
    const data = await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist: windowed, readState: async () => null, log: () => {}, fetchImpl });
    assert.ok(data._state.byId.gamma.processed.includes(gran06('2026-09-03', 33)));
    assert.equal(data._state.byId.gamma.passes.length, baseline.reservoirs.gamma.passes.length);
    assert.equal(data.reservoirs.find((r) => r.id === 'gamma').latest.date < '2026-09-03', true);
  });

  it('buildSummary applies an entry despike allowance', () => {
    const day = (d, level, rgt) => [`${d}T08:00Z`, rgt, level, 0.02, 500, 0.05];
    const passes = [day('2019-01-12', 850.556, 1), day('2019-03-15', 833.919, 2), day('2019-06-05', 819.338, 3), day('2019-09-04', 867.409, 4), day('2019-10-11', 882.612, 5)];
    const byId = { gamma: { passes } };
    const now = Date.parse('2019-10-20T00:00:00Z');
    assert.equal(buildSummary([GAMMA], byId, now).reservoirs[0].recordMinM, 850.556);
    assert.equal(buildSummary([{ ...GAMMA, despikePerGapDayM: 0.3 }], byId, now).reservoirs[0].recordMinM, 819.338);
  });

  it('a reprocessed ATL06 granule revision replaces the earlier level of the same pass', async () => {
    const r1 = gran06('2026-09-03', 33, '01');
    const r2 = gran06('2026-09-03', 33, '02');
    const first = await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => null, log: () => {}, fetchImpl: fake({ cmr: { gamma: [r1] } }).fetchImpl });
    const tupleOf = (data) => data._state.byId.gamma.passes.find((t) => String(t[0]).startsWith('2026-09-03') && t[1] === 33);
    assert.equal(tupleOf(first)[6], undefined, 'revision 1 is not stored');
    const second = await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => first._state, log: () => {}, fetchImpl: fake({ cmr: { gamma: [r1, r2] }, water: 801 }).fetchImpl });
    const pass = tupleOf(second);
    assert.ok(Math.abs(pass[2] - 801.01) < 0.02, `expected the revision 02 level, got ${pass[2]}`);
    assert.equal(pass[6], 2);
  });

  it('planned ATL06 work that never started keeps last-good instead of publishing', async () => {
    const { fetchImpl, calls } = fake({ cmr: { gamma: [gran06('2026-09-03', 33)] } });
    await assert.rejects(
      fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => null, log: () => {}, fetchImpl, deadlineAtMs: Date.now() - 1 }),
      (err) => err.preservableFetchFailure === true && /no SlideRule request started for 1 planned/.test(err.message),
    );
    assert.equal(calls.slide.length, 0);
  });

  it('starts ATL06 entries before ATL13 entries so the run deadline cannot always skip them', async () => {
    // Watchlist order puts ATL13 first; ATL06 entries are few and capped by their own
    // budget, so starting them first cannot starve ATL13 the same way.
    const { fetchImpl, calls } = fake({ cmr: { alpha: [gran('2026-09-02', 21)], gamma: [gran06('2026-09-03', 33)] } });
    await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => null, log: () => {}, fetchImpl });
    assert.deepEqual(calls.slide.map((c) => c.path), ['/source/atl06x', '/source/atl13x']);
  });

  it('budgets ATL06 granules separately from ATL13 granules', async () => {
    assert.ok(MAX_ATL06_GRANULES_PER_RUN < MAX_GRANULES_PER_RUN);
    const g06 = Array.from({ length: 6 }, (_, i) => gran06(`2026-09-${String(10 + i * 3).padStart(2, '0')}`, 40 + i));
    const g13 = Array.from({ length: 4 }, (_, i) => gran(`2026-09-${String(10 + i * 3).padStart(2, '0')}`, 60 + i));
    const { fetchImpl, calls } = fake({ cmr: { alpha: g13, gamma: g06 } });
    const data = await fetchReservoirLevels({ nowMs: NOW, baseline, watchlist, readState: async () => null, log: () => {}, fetchImpl, budget: 3, atl06Budget: 2 });
    const fetched = (path) => calls.slide.filter((c) => c.path === path).flatMap((c) => c.resources);
    // ATL06 is capped at its own budget; it neither borrows from nor starves ATL13.
    assert.deepEqual(fetched('/source/atl06x'), g06.slice(0, 2));
    assert.deepEqual(fetched('/source/atl13x'), g13.slice(0, 3));
    // The rest stays queued: the cursor advanced only to the fetched granules.
    assert.equal(data._state.byId.gamma.cursor, '2026-09-13');
  });
});
