/**
 * ASN-attributed internet outages (owner ruling, 2026-10-24).
 *
 * Cloudflare Radar files some outages against a network (an ASN) rather than a
 * country: a regional ISP, a data centre, a cloud. The seeder used to drop
 * them. The rule: an ASN outage counts for the country Radar places that ASN
 * in only when it disrupted more than CII_OUTAGE_ASN_NATIONAL_SHARE (40%) of
 * that country's Internet. The measure (scripts/lib/radar-asn-impact.mjs) is
 * structured, never text: the ASNs' share of the country's traffic in the week
 * before, times their own traffic drop during the outage. An impact that cannot
 * be measured is excluded and reported, never treated as above the threshold.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessCiiInputAvailability,
  ciiInputExclusions,
  computeCiiScoreTable,
  outageVerdict,
  withCiiInputQuietClocks,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import {
  CII_OUTAGE_ASN_NATIONAL_SHARE,
  CII_OUTAGE_SCORED_CAUSES,
  CII_OUTAGE_WINDOW_MS,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { assessCiiInputs } from '../api/_cii-input-health.js';
import {
  ASN_IMPACT_BUDGET_MS,
  ASN_IMPACT_CAUSES,
  ASN_IMPACT_DEADLINE_MARGIN_MS,
  ASN_IMPACT_MEASURE,
  ASN_IMPACT_WINDOW_MS,
  asnCountryGroups,
  asnImpactBudgetMs,
  measureAsnImpactsWithinBudget,
  measureAsnNationalImpact,
  trafficDrop,
} from '../scripts/lib/radar-asn-impact.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-10-24T12:00:00Z');

type Outage = Record<string, unknown>;
const asnOutage = (nationalImpact: number | null, extra: Outage = {}): Outage => ({
  id: 'cf-9000-RU', countryCode: 'RU', country: 'Russian Federation', cause: 'MILITARY_ACTION',
  outageType: 'NETWORK', severity: 'OUTAGE_SEVERITY_PARTIAL', detectedAt: NOW - 2 * HOUR, endedAt: 0,
  title: 'Internet disruption on AS41039 DON-FTTH (Russian Federation)', description: 'Data centre drone strike',
  asns: [41039], asnNames: ['DON-FTTH'], nationalImpact, impactMeasure: ASN_IMPACT_MEASURE, ...extra,
});
const table = (asnOutages: Outage[]) =>
  computeCiiScoreTable({ outages: { outages: [], asnOutages } }, { nowMs: NOW, iranEventsEnabled: true });
const boost = (asnOutages: Outage[]) => table(asnOutages).rows.find((row) => row.region === 'RU')!.parts.outageBoost;

describe('CII ASN outages: scored only above the national share', () => {
  it('pins the threshold at 0.40', () => {
    assert.equal(CII_OUTAGE_ASN_NATIONAL_SHARE, 0.4);
  });

  it('scores an ASN outage that disrupted 60% of the country', () => {
    const a = { ...asnOutage(0.6), attribution: 'asn' };
    assert.equal(outageVerdict(a, NOW), 'scored');
    assert.equal(boost([asnOutage(0.6)]), 5);
    assert.deepEqual(ciiInputExclusions(table([asnOutage(0.6)]).aux, NOW), {});
  });

  it('does not score one at 10%, and lists it in the exclusions', () => {
    assert.equal(outageVerdict({ ...asnOutage(0.1), attribution: 'asn' }, NOW), 'asnBelowNationalShare');
    assert.equal(boost([asnOutage(0.1)]), 0);
    const ex = ciiInputExclusions(table([asnOutage(0.1)]).aux, NOW).outages!;
    assert.equal(ex.asnBelowNationalShare!.count, 1);
    assert.equal(ex.asnBelowNationalShare!.samples[0]!.id, 'cf-9000-RU');
  });

  it('excludes exactly 40%: the rule is "more than"', () => {
    assert.equal(boost([asnOutage(0.4)]), 0);
  });

  it('never scores an unmeasured impact, and reports it as unknown', () => {
    for (const impact of [null, Number.NaN]) {
      assert.equal(boost([asnOutage(impact)]), 0);
      assert.equal(ciiInputExclusions(table([asnOutage(impact)]).aux, NOW).outages!.asnImpactUnknown!.count, 1);
    }
    const missingField = asnOutage(null);
    delete missingField.nationalImpact;
    assert.equal(boost([missingField]), 0);
  });

  it('treats an upper bound above the threshold as unknown, and one below it as below', () => {
    assert.equal(outageVerdict({ ...asnOutage(0.5, { impactIsUpperBound: true }), attribution: 'asn' }, NOW), 'asnImpactUnknown');
    assert.equal(outageVerdict({ ...asnOutage(0.002, { impactIsUpperBound: true }), attribution: 'asn' }, NOW), 'asnBelowNationalShare');
  });

  it('applies the cause and window rules first: a below-share power outage is out of construct, not an ASN exclusion', () => {
    const power = asnOutage(0.1, { cause: 'POWER_OUTAGE' });
    assert.equal(outageVerdict({ ...power, attribution: 'asn' }, NOW), 'cause');
    assert.deepEqual(ciiInputExclusions(table([power]).aux, NOW), {});
  });

  it('reads the attribution from where the record was published, not from a field on it', () => {
    // A location record that happens to carry nationalImpact 0 is not an ASN record.
    const located = { ...asnOutage(0), attribution: undefined };
    const t = computeCiiScoreTable({ outages: { outages: [located] } }, { nowMs: NOW, iranEventsEnabled: true });
    assert.equal(t.rows.find((row) => row.region === 'RU')!.parts.outageBoost, 5);
  });
});

/** A MIN0_MAX series over [from, to) in 15-minute buckets (what a short outage is read in): `level(t)` gives each value. */
function series(from: number, to: number, level: (t: number) => number, step = 15 * 60 * 1000) {
  const timestamps: string[] = []; const values: string[] = [];
  for (let t = from; t < to; t += step) { timestamps.push(new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')); values.push(String(level(t))); }
  return { serie_0: { timestamps, values }, meta: { normalization: 'MIN0_MAX' } };
}

describe('radar-asn-impact: the national impact measure', () => {
  const start = Date.parse('2026-10-20T07:00:00Z');
  const end = Date.parse('2026-10-20T10:00:00Z');

  it('groups an annotation\'s ASNs by Radar\'s country for each ASN', () => {
    const groups = asnCountryGroups({
      asnsDetails: [
        { asn: '41039', name: 'DON-FTTH', location: { code: 'RU', name: 'Russian Federation' } },
        { asn: '51004', name: 'SCTS-AS', location: { code: 'RU', name: 'Russian Federation' } },
        { asn: '3215', name: 'Orange S.A.', location: { code: 'FR', name: 'France' } },
        { asn: '1', name: 'no country' },
      ],
    });
    assert.deepEqual(groups, [
      { countryCode: 'RU', countryName: 'Russian Federation', asns: [41039, 51004], asnNames: ['DON-FTTH', 'SCTS-AS'] },
      { countryCode: 'FR', countryName: 'France', asns: [3215], asnNames: ['Orange S.A.'] },
    ]);
  });

  it('measures a traffic drop against the same hours one week earlier', () => {
    const s = series(start - WEEK, end + HOUR, (t) => (t >= start && t < end ? 0.2 : 0.8));
    assert.ok(Math.abs(trafficDrop(s, start, end, HOUR).drop! - 0.75) < 1e-9);
    assert.equal(trafficDrop(series(start, end, () => 0.5), start, end, HOUR).drop, null, 'no baseline week, no measure');
  });

  it('multiplies the ASNs\' traffic share by their drop: 60% share, fully down, is 60% national', async () => {
    const get = async (path: string) => {
      if (path.startsWith('/radar/netflows/top/ases')) return { top_0: [{ clientASN: 41039, value: '60' }, { clientASN: 2, value: '40' }] };
      if (path.startsWith('/radar/netflows/timeseries')) return series(start - WEEK, end + HOUR, (t) => (t >= start && t < end ? 0 : 1));
      throw new Error(`unexpected ${path}`);
    };
    const m = await measureAsnNationalImpact({ get, countryCode: 'RU', asns: [41039], startMs: start, endMs: end, nowMs: NOW });
    assert.ok(Math.abs(m.nationalImpact! - 0.6) < 1e-9, JSON.stringify(m));
    assert.equal(m.impactIsUpperBound, false);
    assert.equal(m.measure, ASN_IMPACT_MEASURE);
  });

  it('bounds an ASN missing from the top-100 list by the smallest listed share', async () => {
    const top = Array.from({ length: 100 }, (_, i) => ({ clientASN: 100 + i, value: i === 99 ? '0.2' : '1' }));
    const get = async (path: string) => (path.startsWith('/radar/netflows/top/ases')
      ? { top_0: top }
      : series(start - WEEK, end + HOUR, (t) => (t >= start && t < end ? 0 : 1)));
    const m = await measureAsnNationalImpact({ get, countryCode: 'RU', asns: [41039], startMs: start, endMs: end, nowMs: NOW });
    assert.ok(Math.abs(m.nationalImpact! - 0.002) < 1e-9, JSON.stringify(m));
    assert.equal(m.impactIsUpperBound, true);
  });

  // Greptile on 864152495: missing data must never read as a measured drop or share.
  const fullDown = (t: number) => (t >= start && t < end ? 0 : 1);
  const withSeries = (seriesFor: () => unknown, top: unknown = { top_0: [{ clientASN: 41039, value: '60' }, { clientASN: 2, value: '40' }] }) =>
    async (path: string) => (path.startsWith('/radar/netflows/top/ases') ? top : seriesFor());
  const measure = (get: (path: string) => Promise<unknown>) =>
    measureAsnNationalImpact({ get, countryCode: 'RU', asns: [41039], startMs: start, endMs: end, nowMs: NOW });
  /** The series with `nullAt(t)` buckets set to null. */
  const holed = (nullAt: (t: number) => boolean) => () => {
    const s = series(start - WEEK, end + HOUR, fullDown);
    s.serie_0.values = s.serie_0.values.map((v, i) => (nullAt(Date.parse(s.serie_0.timestamps[i]!)) ? null : v)) as string[];
    return s;
  };

  it('reads null outage samples as unknown, never as a full drop', async () => {
    const m = await measure(withSeries(holed((t) => t >= start && t < end)));
    assert.equal(m.nationalImpact, null, JSON.stringify(m));
    assert.match(String(m.unknownReason), /missing outage sample/);
    const one = await measure(withSeries(holed((t) => t === start + HOUR)));
    assert.equal(one.nationalImpact, null, 'one null bucket inside the window is enough');
  });

  it('reads null baseline samples as unknown', async () => {
    const m = await measure(withSeries(holed((t) => t >= start - WEEK && t < end - WEEK)));
    assert.equal(m.nationalImpact, null, JSON.stringify(m));
    assert.match(String(m.unknownReason), /missing baseline sample/);
  });

  it('reads a missing top_0 as unknown, not as a zero share', async () => {
    for (const top of [{}, { top_0: null }, null]) {
      const m = await measure(withSeries(() => series(start - WEEK, end + HOUR, fullDown), top));
      assert.equal(m.nationalImpact, null, JSON.stringify(top));
      assert.match(String(m.unknownReason), /top ASes missing/);
    }
  });

  it('reads a null share for the ASN as unknown', async () => {
    for (const value of [null, '', 'n/a', undefined]) {
      const m = await measure(withSeries(() => series(start - WEEK, end + HOUR, fullDown), { top_0: [{ clientASN: 41039, value }, { clientASN: 2, value: '40' }] }));
      assert.equal(m.nationalImpact, null, String(value));
      assert.match(String(m.unknownReason), /share missing/);
    }
  });

  it('never scores an ASN outage built from missing samples', () => {
    // End to end: whatever the measure returns for missing data, the scorer sees null.
    assert.equal(boost([asnOutage(null, { impactUnknownReason: 'AS41039: missing outage sample' })]), 0);
  });

  it('returns an unknown impact when Radar fails or has no baseline', async () => {
    const failing = async () => { throw new Error('HTTP 503'); };
    const m1 = await measureAsnNationalImpact({ get: failing, countryCode: 'RU', asns: [41039], startMs: start, endMs: end, nowMs: NOW });
    assert.equal(m1.nationalImpact, null);
    assert.match(String(m1.unknownReason), /503/);
    const noBaseline = async (path: string) => (path.startsWith('/radar/netflows/top/ases')
      ? { top_0: [{ clientASN: 41039, value: '60' }] }
      : series(start, end, () => 0));
    const m2 = await measureAsnNationalImpact({ get: noBaseline, countryCode: 'RU', asns: [41039], startMs: start, endMs: end, nowMs: NOW });
    assert.equal(m2.nationalImpact, null);
  });
});

describe('radar-asn-impact: one time budget for the whole impact pass', () => {
  const start = Date.parse('2026-10-20T07:00:00Z');
  const end = Date.parse('2026-10-20T10:00:00Z');
  const job = { countryCode: 'RU', asns: [41039], cause: 'MILITARY_ACTION', startMs: start, endMs: end };

  it('derives the budget from runSeed\'s fetch deadline, leaving the margin', () => {
    assert.equal(asnImpactBudgetMs(undefined, NOW), ASN_IMPACT_BUDGET_MS);
    assert.equal(asnImpactBudgetMs(NOW + 20_000, NOW), 20_000 - ASN_IMPACT_DEADLINE_MARGIN_MS);
    assert.equal(asnImpactBudgetMs(NOW + 1_000, NOW), 0);
    assert.equal(asnImpactBudgetMs(NOW + 600_000, NOW), ASN_IMPACT_BUDGET_MS);
  });

  it('settles on time with slow Radar, marking every unfinished ASN unknown: budget', async () => {
    const never = () => new Promise<never>(() => {});
    const began = Date.now();
    const results = await measureAsnImpactsWithinBudget([job, job, job, job, job, job], {
      getWithTimeout: never, budgetMs: 200, nowMs: NOW, concurrency: 2,
    });
    const took = Date.now() - began;
    assert.ok(took < 1_000, `took ${took} ms against a 200 ms budget`);
    assert.equal(results.length, 6);
    for (const r of results) assert.deepEqual([r.nationalImpact, r.unknownReason], [null, 'budget']);
  });

  it('keeps what finished inside the budget and marks only the rest', async () => {
    const fast = async (path: string) => (path.startsWith('/radar/netflows/top/ases')
      ? { top_0: [{ clientASN: 41039, value: '60' }] }
      : series(start - WEEK, end + HOUR, (t) => (t >= start && t < end ? 0 : 1)));
    let calls = 0;
    const firstFastThenStall = (path: string) => (calls++ < 2 ? fast(path) : new Promise<never>(() => {}));
    const results = await measureAsnImpactsWithinBudget([job, job], {
      getWithTimeout: firstFastThenStall, budgetMs: 200, nowMs: NOW, concurrency: 1,
    });
    assert.ok(Math.abs(results[0]!.nationalImpact! - 0.6) < 1e-9);
    assert.equal(results[1]!.unknownReason, 'budget');
  });

  it('skips the pass when no budget is left', async () => {
    let called = false;
    const results = await measureAsnImpactsWithinBudget([job], {
      getWithTimeout: async () => { called = true; return {}; }, budgetMs: 0, nowMs: NOW,
    });
    assert.equal(called, false);
    assert.equal(results[0]!.unknownReason, 'budget');
  });
});

// ------------------------------------------------------------------------
// Round-2 review of 745767739.
// ------------------------------------------------------------------------

describe('radar-asn-impact: the budget is spent only on ASN outages that can score', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const fresh = { countryCode: 'RU', asns: [47541], cause: 'MILITARY_ACTION', startMs: now - 3 * HOUR, endMs: now - HOUR };
  const old = (i: number, cause: string) => ({ countryCode: 'US', asns: [1000 + i], cause, startMs: now - (2 + i) * DAY, endMs: now - (2 + i) * DAY + HOUR });
  const slowFast = (ms: number) => (path: string) => new Promise<unknown>((done) => setTimeout(() => done(path.startsWith('/radar/netflows/top/ases')
    ? { top_0: [{ clientASN: 47541, value: '60' }, { clientASN: 1, value: '40' }] }
    : series(fresh.startMs - WEEK, fresh.endMs + HOUR, (t) => (t >= fresh.startMs && t < fresh.endMs ? 0 : 1))), ms));

  it('pins the seeder\'s cause and window copies to the CII constants', () => {
    assert.deepEqual([...ASN_IMPACT_CAUSES].sort(), [...CII_OUTAGE_SCORED_CAUSES].sort());
    assert.equal(ASN_IMPACT_WINDOW_MS, CII_OUTAGE_WINDOW_MS);
  });

  it('old power and cable outages cannot push a fresh MILITARY_ACTION outage to budget', async () => {
    const jobs = [
      ...Array.from({ length: 6 }, (_, i) => old(i, i % 2 ? 'POWER_OUTAGE' : 'CABLE_CUT')),
      { ...old(0, 'MILITARY_ACTION'), startMs: now - 10 * DAY, endMs: now - 9 * DAY },
      fresh,
    ];
    // Each request takes 40 ms; two requests measure one job; the budget fits about one job.
    const results = await measureAsnImpactsWithinBudget(jobs, { getWithTimeout: slowFast(40), budgetMs: 150, nowMs: now, concurrency: 1 });
    const freshResult = results.at(-1)!;
    assert.ok(Math.abs(freshResult.nationalImpact! - 0.6) < 1e-9, JSON.stringify(freshResult));
    for (const r of results.slice(0, 6)) assert.equal(r.unknownReason, 'not measured: cause out of construct');
    assert.equal(results[6]!.unknownReason, 'not measured: outside the window');
  });

  it('measures the in-construct, in-window outages newest first', async () => {
    const order: string[] = [];
    const get = async (path: string) => { if (path.includes('top/ases')) order.push(path.match(/dateEnd=([^&]+)/)![1]!); throw new Error('stop'); };
    const older = { ...fresh, startMs: now - 3 * DAY, endMs: now - 2 * DAY };
    await measureAsnImpactsWithinBudget([older, fresh], { getWithTimeout: get, budgetMs: 1_000, nowMs: now, concurrency: 1 });
    assert.deepEqual(order.map((d) => Date.parse(d)), [fresh.startMs, older.startMs].map((ms) => Math.floor(ms / (15 * 60 * 1000)) * 15 * 60 * 1000));
  });
});

describe('CII ASN outages: an unknown impact degrades the outages input', () => {
  const unknownRecord = asnOutage(null, { impactUnknownReason: 'HTTP 403' });

  it('reports the outages input degraded, with the reason, when an in-construct ASN outage cannot be measured', () => {
    const t = table([unknownRecord]);
    const states = assessCiiInputAvailability([], t.aux, NOW, false);
    assert.equal(states.outages, 'degraded');
    const reports = withCiiInputQuietClocks(states, null, NOW, { exclusions: ciiInputExclusions(t.aux, NOW) });
    assert.equal(reports.outages.state, 'degraded');
    assert.equal(reports.outages.excluded!.asnImpactUnknown!.samples[0]!.reason, 'HTTP 403');
    const verdict = assessCiiInputs({ inputs: reports }, NOW);
    const dead = verdict.dead.find((d: { id: string }) => d.id === 'outages');
    assert.ok(dead, 'health lists the outages input as dead');
    assert.equal(dead.state, 'degraded');
    assert.deepEqual(dead.excluded, ['asnImpactUnknown']);
  });

  it('stays live or quiet when every unknown ASN outage is out of construct or out of the window', () => {
    const power = asnOutage(null, { cause: 'POWER_OUTAGE' });
    const stale = asnOutage(null, { detectedAt: NOW - 20 * DAY, endedAt: NOW - 19 * DAY });
    assert.equal(assessCiiInputAvailability([], table([power, stale]).aux, NOW, false).outages, 'quiet');
  });

  it('stays live when a located outage scores beside a measured ASN outage', () => {
    const t = computeCiiScoreTable({ outages: { outages: [{ ...asnOutage(0.1), countryCode: 'IQ', description: 'protests' }], asnOutages: [asnOutage(0.1)] } }, { nowMs: NOW, iranEventsEnabled: true });
    assert.equal(assessCiiInputAvailability([], t.aux, NOW, false).outages, 'live');
  });
});

describe('radar-asn-impact: requests and baselines that real Radar data broke', () => {
  it('never asks Radar for data after now: dateEnd before now, or Radar answers 400', async () => {
    const now = Date.parse('2026-10-24T16:47:41Z');
    const start = Date.parse('2026-10-24T13:00:00Z');
    const seen: number[] = [];
    const get = async (path: string) => {
      const dateEnd = Date.parse(decodeURIComponent(path.match(/dateEnd=([^&]+)/)![1]!));
      seen.push(dateEnd);
      if (dateEnd >= now) throw new Error('HTTP 400 Must be before now (utc)');
      return path.includes('top/ases')
        ? { top_0: [{ clientASN: 47541, value: '60' }, { clientASN: 1, value: '40' }] }
        : series(start - WEEK, Math.floor((now - 60_000) / (15 * 60_000)) * 15 * 60_000, (t) => (t >= start ? 0 : 1));
    };
    const m = await measureAsnNationalImpact({ get, countryCode: 'RU', asns: [47541], startMs: start, endMs: 0, nowMs: now });
    assert.ok(seen.every((d) => d < now), JSON.stringify(seen.map((d) => new Date(d).toISOString())));
    assert.ok(Math.abs(m.nationalImpact! - 0.6) < 1e-9, JSON.stringify(m));
  });

  it('keeps the baseline before the outage when it lasts more than a week', async () => {
    // Half down for 21 days. Comparing days 8-21 with days 1-14 (both half
    // down) reads no drop there; the baseline must stay in the week before the
    // outage began, so the drop is 50% throughout and the impact 0.6 x 0.5.
    const start = Date.parse('2026-09-29T00:00:00Z');
    const end = Date.parse('2026-10-20T00:00:00Z');
    const get = async (path: string) => (path.includes('top/ases')
      ? { top_0: [{ clientASN: 47541, value: '60' }, { clientASN: 1, value: '40' }] }
      : series(start - WEEK, end + HOUR, (t) => (t >= start && t < end ? 0.5 : 1), HOUR));
    const m = await measureAsnNationalImpact({ get, countryCode: 'RU', asns: [47541], startMs: start, endMs: end, nowMs: end + DAY });
    assert.ok(Math.abs(m.nationalImpact! - 0.3) < 1e-9, JSON.stringify(m));
  });
});
