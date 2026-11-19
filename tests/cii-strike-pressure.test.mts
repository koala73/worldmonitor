// CII v12 strike pressure. Owner decision (2026-10-19): "if a country is being
// striked the instability should go upwards, and keep growing if keep getting
// attacked, and decay with time if otherwise, this makes sense, worldwide".
//
// Live v11 on 2026-10-19 had Saudi Arabia at 54 under repeated missile and
// drone strikes on Riyadh, Prince Sultan Air Base and Najran: the 72h
// strikeBoost sat inside Conflict, which carries 18% of the composite, and
// forgot every strike after three days. v12 tallies strikes per country and
// day (the relay's confirmed feed, and GDELT strike coverage worldwide),
// decays them with a three-day half-life, and maps the result into a floor
// and a capped boost on the composite.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import {
  CII_STRIKE_BOOST_CAP,
  CII_STRIKE_CONFIRMED_MAX_AGE_MS,
  CII_STRIKE_FLOOR_CAP,
  CII_STRIKE_FLOOR_MIN_PRESSURE,
  CII_STRIKE_GDELT_SUSTAINED_DAYS,
  CII_STRIKE_HALF_LIFE_DAYS,
  CII_STRIKE_SEVERITY_WEIGHTS,
  CII_STRIKE_WINDOW_DAYS,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import {
  computeCIIScores,
  confirmedStrikeDaysFromEvents,
  confirmedStrikeDaysFromSeed,
  gdeltCountryEventsFromSeed,
  gdeltStrikeDays,
  strikePressure,
  strikePressureBoost,
  strikePressureFloor,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Noon UTC: the day's midpoint, so today's strikes have age zero.
const NOW = Date.parse('2026-10-19T12:00:00Z');
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => dayOf(NOW - n * DAY);

/** A run of `days` days, `perDay` strike weight each, ending `endAgo` days ago. */
function campaign(perDay: number, days: number, endAgo = 0): Record<string, number> {
  return Object.fromEntries(Array.from({ length: days }, (_, i) => [daysAgo(endAgo + i), perDay]));
}

function aux(extra: Record<string, unknown> = {}) {
  return {
    ucdpEvents: [], outages: [], climate: [], fires: {}, gpsHexes: [], iranEvents: [],
    orefData: null, advisories: null, displacedByIso3: {}, newsTopStories: [], threatSummaryByCountry: null,
    aviationAlerts: [], earthquakes: [], sanctionsCountries: [], sanctionsCountryCounts: null,
    temporalAnomalies: [], militaryCii: null, gdeltCountryEvents: null, confirmedStrikes: null,
    ...extra,
  } as any;
}

function score(a: any, code: string, acled: any[] = []) {
  const s = computeCIIScores(acled, a, { nowMs: NOW }).find((row) => row.region === code);
  assert.ok(s, `expected a score for ${code}`);
  return s;
}

/** A relay tally snapshot: { date: { CC: [critical, high, elevated, moderate] } }. */
function tally(days: Record<string, Record<string, [number, number, number, number]>>, updatedAt = NOW - 10 * 60_000) {
  return { version: 1, days, events: {}, updatedAt };
}

describe('strike pressure decay', () => {
  it('weighs a strike fully on its day, half after one half-life, and almost nothing after three weeks', () => {
    assert.equal(strikePressure({ [daysAgo(0)]: 8 }, NOW), 8);
    assert.ok(Math.abs(strikePressure({ [daysAgo(CII_STRIKE_HALF_LIFE_DAYS)]: 8 }, NOW) - 4) < 1e-9);
    assert.ok(strikePressure({ [daysAgo(14)]: 8 }, NOW) < 0.4, 'negligible after two weeks');
    assert.equal(strikePressure({ [daysAgo(CII_STRIKE_WINDOW_DAYS)]: 8 }, NOW), 0, 'outside the window');
  });

  it('keeps growing while a country is hit every day, toward a steady state set by the attack rate', () => {
    let previous = 0;
    for (let days = 1; days <= 14; days++) {
      const p = strikePressure(campaign(6, days), NOW);
      assert.ok(p > previous, `day ${days}: ${p} must exceed ${previous}`);
      previous = p;
    }
    const steady = 6 / (1 - 0.5 ** (1 / CII_STRIKE_HALF_LIFE_DAYS));
    assert.ok(previous < steady && previous > 0.9 * steady, `two weeks of strikes (${previous}) approach ${steady}`);
    assert.ok(strikePressure(campaign(12, 14), NOW) > 1.9 * previous, 'twice the attack rate, twice the pressure');
  });

  it('decays once the strikes stop: halved in three days, a tenth in ten', () => {
    const atStop = strikePressure(campaign(6, 10), NOW);
    const later = (days: number) => strikePressure(campaign(6, 10), NOW + days * DAY);
    assert.ok(Math.abs(later(3) - atStop / 2) < 0.05 * atStop);
    assert.ok(later(10) < 0.11 * atStop);
  });

  it('treats a missing or malformed day as no evidence, never as a negative', () => {
    assert.equal(strikePressure(undefined, NOW), 0);
    assert.equal(strikePressure({ [daysAgo(0)]: -5, 'not-a-date': 9, [daysAgo(1)]: Number.NaN }, NOW), 0);
    assert.equal(strikePressure({ [dayOf(NOW + 2 * DAY)]: 9 }, NOW), 0, 'a future day is not counted');
  });
});

describe('strike pressure floor and boost', () => {
  it('puts no floor under a country below the minimum pressure, then raises it with each doubling to the cap', () => {
    assert.equal(strikePressureFloor(CII_STRIKE_FLOOR_MIN_PRESSURE - 0.01), 0);
    let previous = 0;
    for (const p of [CII_STRIKE_FLOOR_MIN_PRESSURE, 10, 20, 40, 80]) {
      const floor = strikePressureFloor(p);
      assert.ok(floor > previous, `floor(${p}) = ${floor} must rise`);
      previous = floor;
    }
    assert.equal(strikePressureFloor(10_000), CII_STRIKE_FLOOR_CAP);
  });

  it('adds a boost that grows with pressure and stops at its cap', () => {
    assert.equal(strikePressureBoost(0), 0);
    assert.ok(strikePressureBoost(5) > 0);
    assert.ok(strikePressureBoost(40) > strikePressureBoost(10));
    assert.equal(strikePressureBoost(10_000), CII_STRIKE_BOOST_CAP);
  });
});

describe('confirmed strike days', () => {
  it('the relay tally ranks a day by the same severity weights the scorer applies', () => {
    const require = createRequire(import.meta.url);
    const strikes = require('../scripts/lib/middle-east-strikes.cjs');
    assert.deepEqual({ ...strikes.PRESSURE_WEIGHTS }, { ...CII_STRIKE_SEVERITY_WEIGHTS });
    assert.deepEqual(strikes.PRESSURE_SEVERITIES, ['critical', 'high', 'elevated', 'moderate']);
  });

  it('weighs the relay tally by severity and moves Gaza to Israel like every strike input', () => {
    const days = confirmedStrikeDaysFromSeed(tally({
      [daysAgo(0)]: { SA: [1, 2, 1, 2], PS: [0, 1, 0, 0], IL: [0, 0, 1, 0] },
      [daysAgo(1)]: { SA: [0, 0, 0, 1], KW: [0, 1, 0, 0] },
    }), NOW)!;
    const w = CII_STRIKE_SEVERITY_WEIGHTS;
    assert.equal(days.SA![daysAgo(0)], w.critical + 2 * w.high + w.elevated + 2 * w.moderate);
    assert.equal(days.IL![daysAgo(0)], w.high + w.elevated);
    assert.equal(days.SA![daysAgo(1)], w.moderate);
    assert.equal(days.KW, undefined, 'a non-Tier-1 country scores nowhere');
  });

  it('ignores a stale or malformed tally (the relay stopped), instead of freezing it', () => {
    const fresh = tally({ [daysAgo(0)]: { SA: [0, 1, 0, 0] } });
    assert.ok(confirmedStrikeDaysFromSeed(fresh, NOW));
    assert.equal(confirmedStrikeDaysFromSeed({ ...fresh, updatedAt: NOW - CII_STRIKE_CONFIRMED_MAX_AGE_MS - 1 }, NOW), null);
    assert.equal(confirmedStrikeDaysFromSeed({ ...fresh, updatedAt: undefined }, NOW), null);
    assert.equal(confirmedStrikeDaysFromSeed(null, NOW), null);
    assert.equal(confirmedStrikeDaysFromSeed({ updatedAt: NOW, days: [] }, NOW), null);
    const garbage = confirmedStrikeDaysFromSeed(tally({ [daysAgo(0)]: { SA: [1, 'x', 0, 0] as any, YE: [0, 1, 0] as any } }), NOW)!;
    assert.deepEqual(garbage, {});
  });

  it('reads the same weights from the 72h window, by the UTC day each strike happened', () => {
    const days = confirmedStrikeDaysFromEvents([
      { id: 'a', countryCode: 'SA', severity: 'high', timestamp: NOW - 2 * HOUR },
      { id: 'b', countryCode: 'SA', severity: 'critical', timestamp: NOW - DAY },
      { id: 'c', countryCode: 'SA', severity: 'low', timestamp: NOW - HOUR }, // not a feed severity
      { id: 'd', countryCode: 'YE', severity: 'moderate', timestamp: 'yesterday' },
    ], NOW);
    assert.deepEqual(days, { SA: { [daysAgo(0)]: CII_STRIKE_SEVERITY_WEIGHTS.high, [daysAgo(1)]: CII_STRIKE_SEVERITY_WEIGHTS.critical } });
  });
});

describe('GDELT strike days', () => {
  // [strikeArticles, articles] per day, and the measured days with their cohorts.
  const measured = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [daysAgo(i), 96]));
  const steady = (strikes: number, articles: number, n = 7) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [daysAgo(i), [strikes, articles] as [number, number]]));

  it('scores strike coverage as a share of the day, so the largest media market is not the largest war', () => {
    // Oct 5-18 2026 means: the US files 1.5 strike articles a day out of 5,768;
    // Ukraine 4.2 out of 359; Saudi Arabia, under Houthi missile fire, 16 of 296.
    const us = gdeltStrikeDays(steady(2, 5768), measured(21), NOW);
    const ua = gdeltStrikeDays(steady(4, 359), measured(21), NOW);
    const sa = gdeltStrikeDays(steady(16, 296), measured(21), NOW);
    assert.equal(Object.values(us).reduce((a, b) => a + b, 0), 0, 'US coverage stays under the noise floor');
    assert.ok(ua[daysAgo(0)]! > 0);
    assert.ok(sa[daysAgo(0)]! > 3 * ua[daysAgo(0)]!);
  });

  it('trusts GDELT alone only for a campaign: a one-day missile-test spike is not a strike on the country', () => {
    // North Korea's Oct 12 launches: 8 of 51 articles that day, nothing around it.
    const spike = gdeltStrikeDays({ [daysAgo(0)]: [8, 51] }, measured(21), NOW);
    assert.deepEqual(spike, {});
    const sustained = Object.fromEntries(Array.from({ length: CII_STRIKE_GDELT_SUSTAINED_DAYS }, (_, i) => [daysAgo(i), [8, 51] as [number, number]]));
    assert.ok(Object.keys(gdeltStrikeDays(sustained, measured(21), NOW)).length > 0);
  });

  it('cannot call a campaign from two measured days, but reads a campaign through unmeasured gaps', () => {
    // Only two of the last seven days measured (the rest predate the strike
    // counter): too little to tell a campaign from a spike.
    const rows = steady(16, 296, 7);
    assert.deepEqual(gdeltStrikeDays(rows, { [daysAgo(0)]: 96, [daysAgo(1)]: 96 }, NOW), {});
    // Every other day unmeasured (a repair backlog), every measured day struck:
    // that is a campaign, not calm.
    const alternate = Object.fromEntries([0, 2, 4, 6].map((n) => [daysAgo(n), 96]));
    const read = gdeltStrikeDays(rows, alternate, NOW);
    assert.ok(read[daysAgo(0)]! > 0 && read[daysAgo(2)]! > 0, 'the recent struck days count');
    assert.equal(read[daysAgo(6)], undefined, 'the oldest day has one measured day around it: no context yet');
  });

  it('keeps decaying a GDELT-only campaign after it stops, instead of dropping it when the last week goes quiet', () => {
    // Fourteen days at 3% of coverage, then nothing: the campaign days stay
    // campaign days, so pressure halves every three days rather than vanishing.
    const measuredAll = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [daysAgo(i), 96]));
    const counts = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [daysAgo(7 + i), [9, 300] as [number, number]]));
    const at = (daysLater: number) => strikePressure(gdeltStrikeDays(counts, measuredAll, NOW), NOW + daysLater * DAY);
    const p0 = strikePressure(gdeltStrikeDays(counts, measuredAll, NOW), NOW);
    assert.ok(p0 > 0, 'a campaign that ended a week ago still weighs');
    assert.ok(Math.abs(at(3) - p0 / 2) < 0.05 * p0, `${at(3)} is half of ${p0}`);
  });

  it('parses the summary strike fields strictly and gates them on freshness', () => {
    const snapshot = {
      byCountry: { SA: { conflict: null, protest: null, week: null, strikes: { [daysAgo(0)]: [16, 296], bad: [1, 2], [daysAgo(1)]: [400, 10] } } },
      baselineReady: false, currentComplete: false, weekReady: false,
      strikeDays: measured(7), updatedAt: NOW - 10 * 60_000,
    };
    const parsed = gdeltCountryEventsFromSeed(snapshot, NOW)!;
    assert.deepEqual(parsed.byCountry.SA!.strikes, { [daysAgo(0)]: [16, 296] }, 'a malformed day or more strikes than articles is dropped');
    assert.equal(Object.keys(parsed.strikeDays!).length, 7);
    assert.equal(gdeltCountryEventsFromSeed({ ...snapshot, updatedAt: NOW - 7 * HOUR }, NOW), null);
  });
});

describe('strike pressure in the CII composite', () => {
  const saCampaign = (days: number, perDay: [number, number, number, number], endAgo = 0) => tally(
    Object.fromEntries(Array.from({ length: days }, (_, i) => [daysAgo(endAgo + i), { SA: perDay }])),
  );

  it('raises a country under sustained confirmed strikes, and keeps raising it while the strikes continue', () => {
    const calm = score(aux(), 'SA').combinedScore;
    const three = score(aux({ confirmedStrikes: confirmedStrikeDaysFromSeed(saCampaign(3, [0, 3, 1, 0]), NOW) }), 'SA').combinedScore;
    const ten = score(aux({ confirmedStrikes: confirmedStrikeDaysFromSeed(saCampaign(10, [0, 3, 1, 0]), NOW) }), 'SA').combinedScore;
    assert.ok(three > calm, `three days of strikes (${three}) must exceed calm (${calm})`);
    assert.ok(ten > three, `ten days (${ten}) must exceed three (${three})`);
    assert.ok(ten <= CII_STRIKE_FLOOR_CAP + CII_STRIKE_BOOST_CAP + 20, 'bounded');
  });

  it('drifts back toward the calm level once the strikes stop', () => {
    const calm = score(aux(), 'SA').combinedScore;
    const at = (stoppedDaysAgo: number) => score(aux({
      confirmedStrikes: confirmedStrikeDaysFromSeed(saCampaign(10, [0, 3, 1, 0], stoppedDaysAgo), NOW),
    }), 'SA').combinedScore;
    assert.ok(at(0) > at(3) && at(3) > at(7), `${at(0)} > ${at(3)} > ${at(7)}`);
    assert.ok(at(14) - calm <= 2, `two weeks after the last strike (${at(14)}) is back near calm (${calm})`);
  });

  it('lifts a country already above every floor when it is hit harder (the boost sits on top of the blend)', () => {
    // Yemen at war: v11 already scores it in the 80s from news, displacement
    // and its GDELT conflict share (39% of a week's coverage on Oct 19).
    const yemen = (perDay: [number, number, number, number] | null) => score(aux({
      advisories: { byCountry: { YE: 'do-not-travel' } },
      displacedByIso3: { YEM: 4_500_000 },
      newsTopStories: Array.from({ length: 30 }, () => ({ countryCode: 'YE', threatLevel: 'critical', primaryTitle: 'Yemen strikes' })),
      gdeltCountryEvents: gdeltCountryEventsFromSeed({
        byCountry: { YE: { conflict: null, protest: null, week: { articles: 1000, conflict: 390, protest: 10 } } },
        baselineReady: false, currentComplete: false, weekReady: true, updatedAt: NOW - 10 * 60_000,
      }, NOW),
      confirmedStrikes: perDay
        ? confirmedStrikeDaysFromSeed(tally(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [daysAgo(i), { YE: perDay }]))), NOW)
        : null,
    }), 'YE').combinedScore;
    const unstruck = yemen(null);
    const light = yemen([0, 1, 0, 0]);
    const heavy = yemen([1, 3, 1, 0]);
    assert.ok(unstruck > CII_STRIKE_FLOOR_CAP, `fixture must start above every floor (${unstruck})`);
    assert.ok(light > unstruck && heavy > light, `${unstruck} < ${light} < ${heavy}`);
  });

  it('counts a strike once when the 72h window and the 30-day tally both carry it', () => {
    const events = [
      { id: 'a', countryCode: 'SA', severity: 'high', timestamp: NOW - 2 * HOUR },
      { id: 'b', countryCode: 'SA', severity: 'high', timestamp: NOW - 3 * HOUR },
    ];
    const durable = confirmedStrikeDaysFromSeed(tally({ [daysAgo(0)]: { SA: [0, 2, 0, 0] } }), NOW);
    const both = score(aux({ iranEvents: events, confirmedStrikes: durable }), 'SA').combinedScore;
    const tallyOnly = score(aux({ confirmedStrikes: durable }), 'SA').combinedScore;
    const windowOnly = score(aux({ iranEvents: events }), 'SA').combinedScore;
    assert.equal(both, tallyOnly);
    assert.equal(both, windowOnly);
  });

  it('counts the same strike once when the feed and GDELT both report it (the larger day wins)', () => {
    const confirmed = confirmedStrikeDaysFromSeed(saCampaign(7, [0, 3, 1, 0]), NOW);
    const gdelt = gdeltCountryEventsFromSeed({
      byCountry: { SA: { conflict: null, protest: null, week: null, strikes: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [daysAgo(i), [16, 296]])) } },
      baselineReady: false, currentComplete: false, weekReady: false,
      strikeDays: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [daysAgo(i), 96])), updatedAt: NOW - 10 * 60_000,
    }, NOW);
    const both = score(aux({ confirmedStrikes: confirmed, gdeltCountryEvents: gdelt }), 'SA');
    // The same scores as the per-day maximum fed in as one source.
    const gd = gdeltStrikeDays(gdelt!.byCountry.SA!.strikes, gdelt!.strikeDays, NOW);
    const larger: Record<string, number> = { ...confirmed!.SA };
    for (const [d, v] of Object.entries(gd)) larger[d] = Math.max(larger[d] ?? 0, v);
    const asOne = score(aux({ confirmedStrikes: { SA: larger } }), 'SA');
    assert.equal(both.combinedScore, asOne.combinedScore);
    const summed: Record<string, number> = { ...confirmed!.SA };
    for (const [d, v] of Object.entries(gd)) summed[d] = (summed[d] ?? 0) + v;
    assert.ok(strikePressure(larger, NOW) < strikePressure(summed, NOW), 'the fixture must overlap, or the test proves nothing');
  });

  it('no longer counts strikes inside Conflict: the old 72h strikeBoost is replaced, not added to', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, countryCode: 'SA', severity: 'critical', timestamp: NOW - i * HOUR }));
    const calm = score(aux(), 'SA');
    const hit = score(aux({ iranEvents: events }), 'SA');
    assert.equal(hit.components!.geoConvergence, calm.components!.geoConvergence);
    assert.ok(hit.combinedScore > calm.combinedScore);
  });

  it('reads GDELT strikes only while ACLED is dark, like the other GDELT terms', () => {
    const gdelt = gdeltCountryEventsFromSeed({
      byCountry: { UA: { conflict: null, protest: null, week: null, strikes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [daysAgo(i), [20, 359]])) } },
      baselineReady: false, currentComplete: false, weekReady: false,
      strikeDays: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [daysAgo(i), 96])), updatedAt: NOW - 10 * 60_000,
    }, NOW);
    const acled = [{ country: 'Brazil', event_type: 'Protests', fatalities: 0 }];
    assert.ok(score(aux({ gdeltCountryEvents: gdelt }), 'UA').combinedScore > score(aux(), 'UA').combinedScore);
    assert.equal(score(aux({ gdeltCountryEvents: gdelt }), 'UA', acled).combinedScore, score(aux(), 'UA', acled).combinedScore);
  });
});
