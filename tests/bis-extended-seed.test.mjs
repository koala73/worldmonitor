import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseBisCSV,
  selectBestSeriesByCountry,
  buildDsr,
  buildPropertyPrices,
  quarterToDate,
  validate,
  publishTransform,
  planDatasetAction,
  publishDatasetIndependently,
  dsrAfterPublish,
  KEYS,
  META_KEYS,
} from '../scripts/seed-bis-extended.mjs';

// Minimal BIS-style SDMX CSV fixture covering:
//   - Two DSR series per country (one private/adjusted → preferred, one
//     households/unadjusted → deprioritised) so selectBestSeriesByCountry
//     has to use dimension prefs to pick.
//   - A real-index SPP series plus a YoY-pct series — the real-index
//     variant (UNIT_MEASURE=628, PP_VALUATION=R) must win.
//   - Missing values (`.`) and empty rows — must be discarded.
const DSR_CSV = [
  'FREQ,BORROWERS_CTY,DSR_BORROWERS,DSR_ADJUST,TIME_PERIOD,OBS_VALUE',
  'Q,US,P,A,2023-Q2,9.8',
  'Q,US,P,A,2023-Q3,10.1',
  'Q,US,P,A,2023-Q4,10.4',
  'Q,US,H,U,2023-Q2,7.5',
  'Q,US,H,U,2023-Q3,7.6',
  'Q,GB,P,A,2023-Q3,8.2',
  'Q,GB,P,A,2023-Q4,.',
  'Q,GB,P,A,2023-Q4,8.5',
  '',
].join('\n');

const SPP_CSV = [
  'FREQ,REF_AREA,UNIT_MEASURE,PP_VALUATION,TIME_PERIOD,OBS_VALUE',
  'Q,US,628,R,2022-Q4,100.0',
  'Q,US,628,R,2023-Q1,101.2',
  'Q,US,628,R,2023-Q2,102.5',
  'Q,US,628,R,2023-Q3,103.0',
  'Q,US,628,R,2023-Q4,104.1',
  'Q,US,628,R,2024-Q4,108.5',
  'Q,US,771,R,2023-Q3,5.4', // YoY-change variant — must not be chosen
  'Q,XM,628,R,2023-Q4,99.0',
  'Q,XM,628,R,2024-Q4,100.5',
].join('\n');

describe('seed-bis-extended parser', () => {
  it('exports the canonical Redis keys', () => {
    assert.equal(KEYS.dsr, 'economic:bis:dsr:v1');
    assert.equal(KEYS.spp, 'economic:bis:property-residential:v1');
    assert.equal(KEYS.cpp, 'economic:bis:property-commercial:v1');
  });

  it('exports per-dataset seed-meta keys distinct from the aggregate', () => {
    // Health monitoring (api/health.js bisDsr / bisPropertyResidential /
    // bisPropertyCommercial) points at these keys — the whole point of the
    // P1 fix is that a DSR-only outage stales ONLY bisDsr, not all three.
    assert.equal(META_KEYS.dsr, 'seed-meta:economic:bis-dsr');
    assert.equal(META_KEYS.spp, 'seed-meta:economic:bis-property-residential');
    assert.equal(META_KEYS.cpp, 'seed-meta:economic:bis-property-commercial');
    // Must not collide with the aggregate "seeder ran" marker.
    assert.notEqual(META_KEYS.dsr, 'seed-meta:economic:bis-extended');
    assert.notEqual(META_KEYS.spp, 'seed-meta:economic:bis-extended');
    assert.notEqual(META_KEYS.cpp, 'seed-meta:economic:bis-extended');
  });

  it('maps BIS quarter strings to first day of the quarter', () => {
    assert.equal(quarterToDate('2023-Q3'), '2023-07-01');
    assert.equal(quarterToDate('2024-Q1'), '2024-01-01');
    assert.equal(quarterToDate('2024-Q4'), '2024-10-01');
    // Non-quarterly strings pass through unchanged (monthly or daily BIS periods).
    assert.equal(quarterToDate('2024-06'), '2024-06');
  });

  it('parses CSV rows and drops blank lines', () => {
    const rows = parseBisCSV(DSR_CSV);
    assert.ok(rows.length >= 7, 'expected at least 7 non-empty rows');
    assert.equal(rows[0].TIME_PERIOD, '2023-Q2');
    assert.equal(rows[0].BORROWERS_CTY, 'US');
  });

  it('buildDsr prefers DSR_BORROWERS=P / DSR_ADJUST=A and returns latest+QoQ', () => {
    const rows = parseBisCSV(DSR_CSV);
    const entries = buildDsr(rows);
    const us = entries.find(e => e.countryCode === 'US');
    assert.ok(us, 'expected US entry');
    // The adjusted-private series wins, so latest must be 10.4 not 7.6.
    assert.equal(us.dsrPct, 10.4);
    assert.equal(us.previousDsrPct, 10.1);
    assert.equal(us.period, '2023-Q4');
    assert.equal(us.date, '2023-10-01');
    assert.ok(us.change !== null);
  });

  it('buildPropertyPrices picks the real-index series (628/R) and computes YoY', () => {
    const rows = parseBisCSV(SPP_CSV);
    const entries = buildPropertyPrices(rows, 'residential');
    const us = entries.find(e => e.countryCode === 'US');
    assert.ok(us, 'expected US entry');
    assert.equal(us.indexValue, 108.5); // latest observation
    assert.equal(us.period, '2024-Q4');
    assert.equal(us.kind, 'residential');
    // YoY: 108.5 / 104.1 − 1 ≈ 4.2%.
    assert.ok(us.yoyChange !== null && Math.abs(us.yoyChange - 4.2) < 0.2, `yoyChange=${us.yoyChange}`);
    // Euro Area (XM) should also come through.
    const xm = entries.find(e => e.countryCode === 'XM');
    assert.ok(xm, 'expected XM entry');
    assert.equal(xm.kind, 'residential');
  });

  it('decouples DSR / SPP / CPP: DSR empty + SPP+CPP healthy → SPP+CPP written, DSR TTL extended', () => {
    // Simulated fetchAll() output when WS_DSR fetch failed but WS_SPP / WS_CPP
    // succeeded. The previous code hard-gated everything on DSR: publishTransform
    // would yield { entries: [] }, validate() would fail on the full object, and
    // afterPublish() never ran → fresh SPP/CPP data silently dropped. The fix
    // must classify each dataset independently.
    const data = {
      dsr: null,
      spp: { entries: [{ countryCode: 'US', indexValue: 108.5 }], fetchedAt: 't' },
      cpp: { entries: [{ countryCode: 'US', indexValue: 95.2 }], fetchedAt: 't' },
    };
    // SPP/CPP must be WRITTEN (fresh data).
    assert.equal(planDatasetAction(data.spp), 'write');
    assert.equal(planDatasetAction(data.cpp), 'write');
    // DSR must have its EXISTING TTL extended (no canonical overwrite).
    assert.equal(planDatasetAction(data.dsr), 'extend');
    // publishTransform yields an empty DSR payload → validate() returns false
    // → atomicPublish skips the canonical DSR write and extends its TTL via
    // runSeed's own skipped branch (preserving the previous DSR snapshot).
    const publishData = publishTransform(data);
    assert.deepEqual(publishData, { entries: [] });
    assert.equal(validate(publishData), false);
  });

  it('decouples DSR / SPP / CPP: DSR healthy + SPP+CPP empty → DSR written, SPP+CPP TTLs extended', () => {
    // Reverse failure mode: DSR fetch succeeded, SPP/CPP both returned empty
    // (e.g. BIS property-price endpoint hiccup). DSR must still publish fresh
    // data; SPP/CPP old snapshots must survive via TTL extension.
    const data = {
      dsr: { entries: [{ countryCode: 'US', dsrPct: 10.4 }], fetchedAt: 't' },
      spp: null,
      cpp: null,
    };
    assert.equal(planDatasetAction(data.dsr), 'write');
    assert.equal(planDatasetAction(data.spp), 'extend');
    assert.equal(planDatasetAction(data.cpp), 'extend');
    const publishData = publishTransform(data);
    assert.equal(publishData, data.dsr); // passes DSR slice straight through
    assert.equal(validate(publishData), true); // canonical DSR write proceeds
  });

  it('planDatasetAction treats a {entries:[]} slice as extend-TTL (not write)', () => {
    assert.equal(planDatasetAction({ entries: [] }), 'extend');
    assert.equal(planDatasetAction(null), 'extend');
    assert.equal(planDatasetAction(undefined), 'extend');
  });

  it('publishDatasetIndependently writes per-dataset seed-meta ONLY on fresh write, not on extend-TTL', async () => {
    // Capture every Upstash REST call so we can assert which keys were touched.
    const origUrl = process.env.UPSTASH_REDIS_REST_URL;
    const origTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const origFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body); // e.g. ['SET', 'key', 'value', 'EX', 123] or ['EXPIRE', ...]
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    };
    try {
      // 1. Fresh payload → canonical key written + per-dataset seed-meta written.
      calls.length = 0;
      await publishDatasetIndependently(
        KEYS.spp,
        { entries: [{ countryCode: 'US', indexValue: 108.5 }], fetchedAt: 't' },
        META_KEYS.spp,
      );
      const sets = calls.filter(c => c[0] === 'SET').map(c => c[1]);
      assert.ok(sets.includes(KEYS.spp), `expected SET on canonical key ${KEYS.spp}, got ${JSON.stringify(sets)}`);
      assert.ok(sets.includes(META_KEYS.spp), `expected SET on seed-meta key ${META_KEYS.spp}, got ${JSON.stringify(sets)}`);

      // 2. Empty payload → canonical key TTL extended, seed-meta NOT written.
      //    (This is the core P1 invariant: a DSR outage must not refresh
      //     seed-meta:economic:bis-dsr, otherwise health lies "fresh".)
      calls.length = 0;
      await publishDatasetIndependently(KEYS.dsr, null, META_KEYS.dsr);
      const metaSets = calls.filter(c => c[0] === 'SET' && c[1] === META_KEYS.dsr);
      assert.equal(metaSets.length, 0, `seed-meta must NOT be written on extend-TTL path, got ${JSON.stringify(metaSets)}`);
      // Any SET at all on the extend path is wrong — only EXPIRE-style calls expected.
      const canonicalSets = calls.filter(c => c[0] === 'SET' && c[1] === KEYS.dsr);
      assert.equal(canonicalSets.length, 0, `canonical key must NOT be re-written on extend-TTL path`);
    } finally {
      globalThis.fetch = origFetch;
      if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = origUrl;
      if (origTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = origTok;
    }
  });

  it('dsrAfterPublish writes seed-meta:economic:bis-dsr only after a successful canonical DSR publish', async () => {
    // Regression for the ordering bug: previously seed-meta was written
    // INSIDE fetchAll() before runSeed/atomicPublish ran. If atomicPublish
    // then failed (Redis hiccup), seed-meta would already be bumped → health
    // reports DSR fresh while the canonical key is stale. The fix moves the
    // write into an afterPublish callback that fires only on successful
    // canonical publish.
    const origUrl = process.env.UPSTASH_REDIS_REST_URL;
    const origTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const origFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    };
    try {
      // 1. DSR populated → seed-meta IS written (this is the post-publish path).
      calls.length = 0;
      await dsrAfterPublish({
        dsr: { entries: [{ countryCode: 'US', dsrPct: 10.4 }], fetchedAt: 't' },
        spp: null,
        cpp: null,
      });
      const metaSets = calls.filter(c => c[0] === 'SET' && c[1] === META_KEYS.dsr);
      assert.equal(metaSets.length, 1, `expected SET on ${META_KEYS.dsr} after successful publish, got ${JSON.stringify(calls)}`);

      // 2. DSR null/empty → seed-meta NOT written. atomicPublish would have
      //    skipped the canonical write in this case anyway (validate=false),
      //    but this guards against a future caller invoking the hook with an
      //    empty slice.
      calls.length = 0;
      await dsrAfterPublish({ dsr: null, spp: null, cpp: null });
      assert.equal(calls.length, 0, `expected no Redis calls when DSR slice is empty, got ${JSON.stringify(calls)}`);

      calls.length = 0;
      await dsrAfterPublish({ dsr: { entries: [] }, spp: null, cpp: null });
      assert.equal(calls.length, 0, `expected no Redis calls when DSR slice has zero entries`);
    } finally {
      globalThis.fetch = origFetch;
      if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = origUrl;
      if (origTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = origTok;
    }
  });

  it('selectBestSeriesByCountry ignores series with no usable observations', () => {
    const rows = [
      { FREQ: 'Q', REF_AREA: 'US', UNIT_MEASURE: '628', PP_VALUATION: 'R', TIME_PERIOD: '2023-Q1', OBS_VALUE: '.' },
      { FREQ: 'Q', REF_AREA: 'US', UNIT_MEASURE: '628', PP_VALUATION: 'R', TIME_PERIOD: '2023-Q2', OBS_VALUE: '' },
    ];
    const out = selectBestSeriesByCountry(rows, { countryColumns: ['REF_AREA'], prefs: { PP_VALUATION: 'R' } });
    assert.equal(out.size, 0);
  });
});
