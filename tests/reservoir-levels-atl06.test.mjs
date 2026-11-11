// ATL06 path of the strategic reservoir levels: product routing in the shared helpers and
// the lowest-cluster reduction that replaces ATL13's water mask.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ATL06_CLUSTER_GAP_M,
  ATL06_MAX_SLOPE,
  SLIDERULE_ATL06_URL,
  SLIDERULE_ATL13_URL,
  classifyPasses,
  dedupeGranules,
  fetchSegments,
  granuleBase,
  granuleDate,
  granuleRevision,
  granuleRgt,
  listGranules,
  lowestCluster,
  passIsOk,
  productOf,
  reduceRows,
} from '../scripts/_reservoir-levels.mjs';
import { csvFileRecords, csvFromAtl06Rows, streamResponse } from './helpers/sliderule-stream.mjs';

const A1 = 'ATL06_20260601195921_12013101_007_01.h5';
const A2 = 'ATL06_20260603094214_12253101_007_01.h5';

const nsOf = (iso) => String(BigInt(Date.parse(iso)) * 1000000n);

/** Raw atl06x CSV rows (as the CSV reader yields them) for one pass. */
function atl06Row({ t, rgt, gt = 10, h, geoid = -28.2, q = 0, dx = 0 }) {
  return { time_ns: nsOf(t), rgt: String(rgt), gt: String(gt), atl06_quality_summary: String(q), dh_fit_dx: String(dx), h_li: String(h + geoid), 'dem/geoid_h': String(geoid) };
}

/** Deterministic pseudo-random sequence so the synthetic land is the same every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * One pass over a box that is mostly land: a flat water surface at `level`, a dense
 * hillside rising from the shore (steep segments), flat terraces above the water, an
 * exposed lake bed sloping gently up from the shore, and low-quality returns below water.
 */
function contaminatedPass({ t, rgt, level, waterN = 120, seed = 1 }) {
  const rnd = lcg(seed);
  const rows = [];
  const beams = [10, 30, 50];
  for (let i = 0; i < waterN; i++) rows.push(atl06Row({ t, rgt, gt: beams[i % 3], h: level + (rnd() - 0.5) * 0.06, dx: (rnd() - 0.5) * 0.004 }));
  // Hillside: 2000 segments spread continuously from the shore to 250 m above the water.
  for (let i = 0; i < 2000; i++) rows.push(atl06Row({ t, rgt, gt: beams[i % 3], h: level + 0.05 + rnd() * 250, dx: 0.03 + rnd() * 0.3 }));
  // Flat terraces and plateaus well above the water.
  for (let i = 0; i < 300; i++) rows.push(atl06Row({ t, rgt, gt: beams[i % 3], h: level + 12 + Math.floor(rnd() * 4) * 15 + rnd() * 0.2, dx: 0.002 }));
  // Exposed bed of a falling reservoir: gentle, flat-looking, starting 0.7 m above the water.
  for (let i = 0; i < 80; i++) rows.push(atl06Row({ t, rgt, gt: beams[i % 3], h: level + 0.7 + i * 0.05, dx: 0.004 }));
  // Bad-quality returns below the surface must never form the lowest cluster.
  for (let i = 0; i < 50; i++) rows.push(atl06Row({ t, rgt, gt: 10, h: level - 15 - rnd(), q: 1 }));
  return rows;
}

describe('ATL06 product routing', () => {
  it('watchlist entries default to ATL13 and opt in to ATL06', () => {
    assert.equal(productOf({}).id, 'atl13');
    assert.equal(productOf({ product: 'atl06' }).id, 'atl06');
    assert.equal(productOf({ product: 'atl06' }).shortName, 'ATL06');
    assert.throws(() => productOf({ product: 'atl08' }), /unknown reservoir product atl08/);
  });

  it('parses ATL06 granule names and dedupes their revisions', () => {
    assert.equal(granuleDate(A1), '2026-06-01');
    assert.deepEqual(dedupeGranules([A2, A1, A1.replace('_01.h5', '_02.h5')]), [A1.replace('_01.h5', '_02.h5'), A2]);
  });

  it('reads the orbit, revision and RGT of ATL06 and ATL13 names alike', () => {
    for (const product of ['ATL06', 'ATL13']) {
      const name = `${product}_20260601195921_12013101_007_02.h5`;
      assert.equal(granuleBase(name), `${product}_20260601195921_12013101_007`, product);
      assert.equal(granuleRevision(name), 2, product);
      assert.equal(granuleRgt(name), 1201, product);
    }
  });

  it('lists ATL06 v007 granules in CMR and ignores names of another product', async () => {
    let seen = null;
    const fetchImpl = async (url) => {
      seen = new URL(url);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ feed: { entry: [{ producer_granule_id: A1 }, { producer_granule_id: 'ATL13_20260601195921_12013101_007_01.h5' }, { title: `${A2}_HqVmDaBF` }] } }) };
    };
    const names = await listGranules([0, 0, 1, 1], '2026-01-01', fetchImpl, { product: 'atl06' });
    assert.equal(seen.searchParams.get('short_name'), 'ATL06');
    assert.equal(seen.searchParams.get('version'), '007');
    assert.deepEqual(names, [A1, A2]);
  });

  it('posts to atl06x with the geoid field, in batches of 5, and drops rejected segments before buffering', async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: '2026-06-01T20:00:00Z', rgt: 1201, gt: 10, h: 330 + i * 0.001 })),
      { t: '2026-06-01T20:00:00Z', rgt: 1201, gt: 10, h: 300, q: 1 },
      { t: '2026-06-01T20:00:00Z', rgt: 1201, gt: 10, h: 400, dx: 0.2 },
    ];
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parms = JSON.parse(init.body).parms;
      calls.push({ url, parms });
      return streamResponse(csvFileRecords(csvFromAtl06Rows(rows), 50));
    };
    const names = Array.from({ length: 7 }, (_, i) => A1.replace('1201', String(1300 + i)));
    const got = [];
    const r = await fetchSegments([{ lon: 0, lat: 0 }], names, (row) => got.push(row), fetchImpl, { product: 'atl06' });
    assert.deepEqual(calls.map((c) => c.url), [SLIDERULE_ATL06_URL, SLIDERULE_ATL06_URL]);
    assert.deepEqual(calls.map((c) => c.parms.resources.length), [5, 2]);
    assert.deepEqual(calls[0].parms.atl06_fields, ['dem/geoid_h']);
    assert.equal('atl13' in calls[0].parms, false);
    assert.equal(r.processed.length, 7);
    // 10 good rows per request, quality-1 and steep rows dropped; slim rows carry the
    // orthometric height.
    assert.equal(got.length, 20);
    assert.ok(got.every((x) => Math.abs(Number(x.ht_ortho) - 330) < 0.01));
  });

  it('keeps the ATL13 request unchanged by default', async () => {
    let call = null;
    await fetchSegments([], [A1.replace('ATL06', 'ATL13')], () => {}, async (url, init) => {
      call = { url, parms: JSON.parse(init.body).parms };
      return streamResponse([]);
    });
    assert.equal(call.url, SLIDERULE_ATL13_URL);
    assert.deepEqual(call.parms.atl13, { anc_fields: ['atl13refid'] });
  });
});

describe('ATL06 lowest-cluster reduction', () => {
  it('lowestCluster splits at gaps above 0.5 m and skips low clusters below the size floor', () => {
    assert.equal(ATL06_CLUSTER_GAP_M, 0.5);
    // 3 stray low points, then 10 water points, then land 0.9 m higher.
    const h = [310, 310.1, 310.2, ...Array.from({ length: 10 }, (_, i) => 330 + i * 0.01), 331, 331.4, 335, 340];
    const c = lowestCluster(h);
    assert.equal(c.lo, 330);
    assert.equal(c.count, 10);
    assert.ok(Math.abs(c.hi - 330.09) < 1e-9);
    // A gap of exactly 0.5 m does not split.
    assert.equal(lowestCluster([...Array.from({ length: 5 }, () => 10), ...Array.from({ length: 5 }, () => 10.5)]).count, 10);
    // The size floor is 10% of the points once that exceeds 5.
    const many = [...Array.from({ length: 8 }, () => 100), ...Array.from({ length: 100 }, (_, i) => 200 + i * 0.1)];
    assert.equal(lowestCluster(many).lo, 200);
    assert.equal(lowestCluster([1, 2, 3, 4]), null);
  });

  it('reads the water level from a pass dominated by land, terraces, exposed bed and bad returns', () => {
    const rows = contaminatedPass({ t: '2026-06-01T18:00:00Z', rgt: 400, level: 328.84 });
    const [p] = reduceRows(rows, { product: 'atl06' });
    assert.ok(Math.abs(p.levelM - 328.84) < 0.02, `level ${p.levelM}`);
    assert.ok(p.n >= 100 && p.n <= 120, `n ${p.n}`);
    assert.ok(p.madM < 0.05, `mad ${p.madM}`);
    assert.equal(passIsOk(p), true);
    // The same rows read as ATL13 (no mask, no cluster) give a land height, not the lake.
    const [naive] = reduceRows(rows.map((r) => ({ ...r, ht_ortho: String(Number(r.h_li) - Number(r['dem/geoid_h'])) })));
    assert.ok(naive.levelM > 340, `naive ${naive.levelM}`);
  });

  it('needs the slope filter: with flat-looking hillside the cluster chains into the land', () => {
    assert.equal(ATL06_MAX_SLOPE, 0.01);
    const rows = contaminatedPass({ t: '2026-06-01T18:00:00Z', rgt: 400, level: 328.84 }).map((r) => ({ ...r, dh_fit_dx: '0' }));
    const [p] = reduceRows(rows, { product: 'atl06' });
    assert.equal(passIsOk(p), false, `chained pass level ${p.levelM} mad ${p.madM}`);
  });

  it('drops a pass with no cluster large enough to be a water surface', () => {
    const rnd = lcg(7);
    const rows = Array.from({ length: 300 }, (_, i) => atl06Row({ t: '2026-06-01T18:00:00Z', rgt: 5, gt: 10 + (i % 3) * 20, h: 400 + rnd() * 300, dx: 0.001 }));
    assert.deepEqual(reduceRows(rows, { product: 'atl06' }), []);
  });

  it('a level window drops a land-only pass and finds the water under a lower plateau', () => {
    const t = '2026-08-29T08:00:00Z';
    // A pass that misses the water: its only flat surface is a plateau at 1142 m.
    const landOnly = Array.from({ length: 7 }, (_, i) => atl06Row({ t, rgt: 1173, gt: 10 + (i % 3) * 20, h: 1142.6 + i * 0.01 }));
    assert.equal(reduceRows(landOnly, { product: 'atl06' })[0].levelM > 1142, true);
    assert.deepEqual(reduceRows(landOnly, { product: 'atl06', levelWindow: [800, 905] }), []);
    // A pass with flat valley floor below the window and the lake inside it.
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => atl06Row({ t, rgt: 228, gt: 10 + (i % 3) * 20, h: 650 + (i % 5) * 0.02 })),
      ...Array.from({ length: 30 }, (_, i) => atl06Row({ t, rgt: 228, gt: 10 + (i % 3) * 20, h: 861.25 + (i % 3) * 0.01 })),
    ];
    assert.ok(Math.abs(reduceRows(rows, { product: 'atl06' })[0].levelM - 650) < 0.05);
    assert.ok(Math.abs(reduceRows(rows, { product: 'atl06', levelWindow: [800, 905] })[0].levelM - 861.26) < 0.02);
  });

  it('despikes the GERD-style 744 m pass (n = 20) out of an ATL06 fill series', () => {
    const rows = [];
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(2020, 6 + i, 10, 8)).toISOString();
      rows.push(...contaminatedPass({ t: d, rgt: 100 + i, level: 560 + i * 4, seed: i + 1 }));
    }
    // A pass whose only flat surface is 20 segments at 744 m (cloud or a plateau).
    for (let i = 0; i < 20; i++) rows.push(atl06Row({ t: '2021-04-25T08:00:00Z', rgt: 999, gt: 10 + (i % 3) * 20, h: 744.2 + (i % 4) * 0.01 }));
    const passes = reduceRows(rows, { product: 'atl06' });
    const outlier = passes.find((p) => p.rgt === 999);
    assert.equal(outlier.n, 20);
    assert.ok(Math.abs(outlier.levelM - 744.2) < 0.05);
    const c = classifyPasses(passes);
    assert.equal(c.find((p) => p.rgt === 999).spike, true);
    const ok = c.filter((p) => p.ok);
    assert.equal(ok.length, 18);
    ok.forEach((p, i) => assert.ok(Math.abs(p.levelM - (560 + i * 4)) < 0.02, `${p.date} ${p.levelM}`));
  });

  it('reads a real Lake Mead ATL06 pass within 0.03 m of ATL13 (2018-10-20, RGT 341)', () => {
    // Every 16th segment of the real atl06x response over the Mead core box: 605 rows, of
    // which most are desert and canyon walls. ATL13 measured 328.835 m for this pass.
    const lines = readFileSync(new URL('./fixtures/reservoir-levels/mead-atl06-pass-2018-10-20.csv', import.meta.url), 'utf8').trim().split('\n');
    const head = lines[0].split(',');
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
    const [p] = reduceRows(rows, { product: 'atl06' });
    assert.equal(p.date, '2018-10-20');
    assert.equal(p.rgt, 341);
    assert.ok(Math.abs(p.levelM - 328.835) <= 0.03, `level ${p.levelM}`);
    assert.equal(passIsOk(p), true);
  });
});

describe('per-reservoir despike allowance', () => {
  // Gibe III 2019: dry-season drawdown to 819 m between sparse passes, then the Omo flood.
  const series = [['2019-01-12', 850.556], ['2019-03-15', 833.919], ['2019-06-05', 819.338], ['2019-09-04', 867.409], ['2019-10-11', 882.612]]
    .map(([date, levelM], i) => ({ time: `${date}T08:00Z`, date, rgt: 100 + i, levelM, madM: 0.02, n: 500, beamSpreadM: 0.05 }));

  it('the shared 0.05 m/day allowance despikes a real seasonal minimum', () => {
    assert.equal(classifyPasses(series).find((p) => p.date === '2019-06-05').spike, true);
  });

  it('an entry allowance of 0.3 m/day keeps it and still drops a 300 m land pass', () => {
    const withLand = [...series, { time: '2019-07-20T08:00Z', date: '2019-07-20', rgt: 999, levelM: 1142.6, madM: 0.05, n: 7, beamSpreadM: null }];
    const c = classifyPasses(withLand, { perGapDayM: 0.3 });
    assert.equal(c.find((p) => p.date === '2019-06-05').ok, true);
    assert.equal(c.find((p) => p.rgt === 999).spike, true);
  });
});

describe('committed watchlist products', () => {
  const watchlist = JSON.parse(readFileSync(new URL('../scripts/data/strategic-reservoirs.json', import.meta.url), 'utf8')).reservoirs;
  const baseline = JSON.parse(readFileSync(new URL('../scripts/data/reservoir-levels-baseline.json', import.meta.url), 'utf8'));

  it('every entry names a known product; ATL06 entries carry a level window and no ATL13 refid', () => {
    for (const e of watchlist) {
      const p = productOf(e);
      if (p.id === 'atl06') {
        assert.equal(e.refid, undefined, e.id);
        assert.ok(Array.isArray(e.levelWindowM) && e.levelWindowM.length === 2 && e.levelWindowM[0] < e.levelWindowM[1], e.id);
      } else {
        assert.equal(e.levelWindowM, undefined, `${e.id}: level windows are an ATL06 rule`);
      }
    }
  });

  it('every ATL06 entry has baseline passes inside its level window', () => {
    for (const e of watchlist.filter((x) => productOf(x).id === 'atl06')) {
      const passes = baseline.reservoirs[e.id]?.passes ?? [];
      assert.ok(passes.length > 0, e.id);
      for (const t of passes) assert.ok(t[2] >= e.levelWindowM[0] && t[2] <= e.levelWindowM[1], `${e.id} ${t[0]} ${t[2]}`);
    }
  });
});

describe('ATL06 row guards treat empty CSV fields as missing', () => {
  const p = productOf('atl06');
  const good = { atl06_quality_summary: '0', dh_fit_dx: '0.001', h_li: '400.5', 'dem/geoid_h': '-30.2', time_ns: '1', rgt: '1', gt: '10' };

  it('keeps a complete good row and reports h_li - geoid_h', () => {
    assert.ok(p.slim(good));
    assert.ok(Math.abs(p.height(good) - 430.7) < 1e-9);
  });

  for (const field of ['dh_fit_dx', 'dem/geoid_h', 'h_li']) {
    it(`drops a row whose ${field} is empty instead of reading it as 0`, () => {
      const row = { ...good, [field]: '' };
      const slim = p.slim(row);
      const h = slim ? Number(slim.ht_ortho) : NaN;
      assert.ok(!Number.isFinite(h), `slim height ${h}`);
      assert.ok(!Number.isFinite(p.height(row)), `height ${p.height(row)}`);
    });
  }
});

describe('ATL13 height treats an empty ht_ortho as missing', () => {
  it('returns NaN, not a 0 m water level', () => {
    assert.ok(!Number.isFinite(productOf('atl13').height({ ht_ortho: '' })));
    assert.equal(productOf('atl13').height({ ht_ortho: '371.25' }), 371.25);
  });
});
