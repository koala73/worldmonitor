// WorldMonitor has no ACLED access, so the CII Conflict and Unrest components
// had no live event input: acledScore, fatalityScore, civilianBoost and the
// protest/riot terms all read the ACLED API, which returns nothing without a
// token. In October 2026 Houthi strikes hit Riyadh and Dammam and France had
// nationwide riots, and both components stayed 0 for every country.
//
// The replacement input is GDELT volume scored against each country's OWN
// four-week norm (gdelt:bulk:country-events:v1). Raw volume is unusable
// worldwide: GDELT codes so much US crime and policing as conflict that the US
// out-reports Ukraine several times over. The fixtures below are real
// { current, baselineMedian } values computed by summarizeCountryEvents from
// the Sep 10 - Oct 19 2026 export archive.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CII_CONFLICT_ACTIVITY_CAP,
  CII_GDELT_ESCALATION_CAP,
  CII_GDELT_ESCALATION_MAX_AGE_MS,
  CII_GDELT_LEVEL_MIN_ARTICLES,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import {
  computeCIIScores,
  countCiiRealtimeSignalDensityCoverage,
  gdeltCountryEventsFromSeed,
  gdeltEscalationScore,
  gdeltLevelScore,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { summarizeCountryEvents } from '../scripts/_gdelt-country-events.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const QUIET = { current: 0, baselineMedian: 0 };

const CONFLICT = {
  // Riyadh strikes (Oct 12) against the week before (Oct 5).
  SA_OCT12: { current: 173, baselineMedian: 52 },
  SA_OCT05: { current: 60, baselineMedian: 49 },
  // An ordinary weekday for the two largest media markets.
  US_OCT14: { current: 881, baselineMedian: 768.5 },
  GB_OCT14: { current: 149, baselineMedian: 115 },
  // Ukraine's war at its usual intensity.
  UA_OCT12: { current: 57, baselineMedian: 54.5 },
};
const PROTEST = {
  // France's nationwide riots (Oct 19) against its September-October norm.
  FR_OCT19: { current: 73.5, baselineMedian: 10 },
  US_OCT14: { current: 64, baselineMedian: 51 },
  US_OCT19: { current: 62.5, baselineMedian: 54.5 },
  GB_OCT14: { current: 13, baselineMedian: 13 },
};

type Signal = { current: number; baselineMedian: number | null };
type Week = { articles: number; conflict: number; protest: number };

function seed(byCountry: Record<string, { conflict?: Signal; protest?: Signal; week?: Week | null }>, extra = {}) {
  const rows = Object.fromEntries(Object.entries(byCountry).map(([code, row]) => [
    code, { conflict: row.conflict ?? QUIET, protest: row.protest ?? QUIET, week: row.week ?? null },
  ]));
  return {
    byCountry: rows, baselineReady: true, currentComplete: true, weekReady: true,
    updatedAt: NOW - 10 * 60_000, ...extra,
  };
}

function aux(snapshot: unknown = null) {
  return {
    ucdpEvents: [], outages: [], climate: [], fires: {}, gpsHexes: [], iranEvents: [],
    orefData: null, advisories: null, displacedByIso3: {}, newsTopStories: [], threatSummaryByCountry: null,
    aviationAlerts: [], earthquakes: [], sanctionsCountries: [], sanctionsCountryCounts: null,
    temporalAnomalies: [], militaryCii: null,
    gdeltCountryEvents: gdeltCountryEventsFromSeed(snapshot, NOW),
  } as any;
}

function components(snapshot: unknown, code: string, acled: any[] = []) {
  const score = computeCIIScores(acled, aux(snapshot), { nowMs: NOW }).find((s) => s.region === code);
  assert.ok(score, `expected a score for ${code}`);
  return { conflict: score.components!.geoConvergence, unrest: score.components!.ciiContribution };
}

describe('CII Conflict and Unrest from GDELT escalation while ACLED is dark', () => {
  it('scores the Riyadh strikes on Conflict and leaves the week before at zero', () => {
    assert.ok(gdeltEscalationScore(CONFLICT.SA_OCT12) >= 40);
    assert.equal(gdeltEscalationScore(CONFLICT.SA_OCT05), 0);
    assert.ok(components(seed({ SA: { conflict: CONFLICT.SA_OCT12 } }), 'SA').conflict >= 40);
  });

  it('scores the French riots on Unrest', () => {
    assert.equal(gdeltEscalationScore(PROTEST.FR_OCT19), CII_GDELT_ESCALATION_CAP);
    assert.equal(components(seed({ FR: { protest: PROTEST.FR_OCT19 } }), 'FR').unrest, CII_GDELT_ESCALATION_CAP);
  });

  it('keeps the US and GB at zero on ordinary news days despite huge raw volume', () => {
    for (const signal of [CONFLICT.US_OCT14, CONFLICT.GB_OCT14, PROTEST.US_OCT14, PROTEST.US_OCT19, PROTEST.GB_OCT14]) {
      assert.equal(gdeltEscalationScore(signal), 0, JSON.stringify(signal));
    }
    const snapshot = seed({
      US: { conflict: CONFLICT.US_OCT14, protest: PROTEST.US_OCT14 },
      GB: { conflict: CONFLICT.GB_OCT14, protest: PROTEST.GB_OCT14 },
    });
    assert.deepEqual(components(snapshot, 'US'), { conflict: 0, unrest: 0 });
    assert.deepEqual(components(snapshot, 'GB'), { conflict: 0, unrest: 0 });
  });

  it('measures escalation, so a war at its usual tempo adds nothing here', () => {
    // UCDP floors carry chronic wars; this term is the live excess over the norm.
    assert.equal(gdeltEscalationScore(CONFLICT.UA_OCT12), 0);
  });

  it('is capped at the scale of the ACLED activity term it stands in for, however large the spike', () => {
    // v11 raised the cap from 50 to 70 (the ACLED activity cap). Under 50 no
    // GDELT reading lifts Saudi Arabia over its advisory floor even in the
    // strike week; the US, GB and China score the same under both.
    assert.equal(gdeltEscalationScore({ current: 100_000, baselineMedian: 1 }), CII_GDELT_ESCALATION_CAP);
    assert.equal(CII_GDELT_ESCALATION_CAP, CII_CONFLICT_ACTIVITY_CAP);
  });

  it('damps tiny countries, where a few articles are a large ratio', () => {
    assert.equal(gdeltEscalationScore({ current: 6, baselineMedian: 1 }), 0);
  });

  it('scores nothing without a baseline, or from a stale snapshot', () => {
    assert.equal(gdeltEscalationScore({ current: 173, baselineMedian: null }), 0);
    const spike = { SA: { conflict: CONFLICT.SA_OCT12 }, FR: { protest: PROTEST.FR_OCT19 } };
    assert.deepEqual(components(seed(spike, { baselineReady: false }), 'SA'), { conflict: 0, unrest: 0 });
    const stale = seed(spike, { updatedAt: NOW - CII_GDELT_ESCALATION_MAX_AGE_MS - 1 });
    assert.deepEqual(components(stale, 'FR'), { conflict: 0, unrest: 0 });
  });

  it('scores nothing from an incomplete current window, which is unknown rather than calm', () => {
    // After a materializer outage today's window is missing cohorts; scoring it
    // would compare a partial day with a full-day norm.
    const spike = { SA: { conflict: CONFLICT.SA_OCT12 } };
    assert.equal(components(seed(spike, { currentComplete: false }), 'SA').conflict, 0);
    assert.equal(components(seed(spike, { currentComplete: undefined }), 'SA').conflict, 0);
    assert.ok(components(seed(spike), 'SA').conflict >= 40);
  });

  it('does not apply eventMultiplier, which is reserved for verified events', () => {
    // SA carries 2.0 and QA 0.8; the same escalation scores the same.
    const snapshot = seed({ SA: { conflict: CONFLICT.SA_OCT12 }, QA: { conflict: CONFLICT.SA_OCT12 } });
    assert.equal(components(snapshot, 'SA').conflict, components(snapshot, 'QA').conflict);
  });

  it('stands down when ACLED returns events, so a credentialed deploy never double counts', () => {
    const snapshot = seed({ SA: { conflict: CONFLICT.SA_OCT12 }, FR: { protest: PROTEST.FR_OCT19 } });
    const acled = [{ country: 'Ukraine', event_type: 'Battles', fatalities: 0, daysAgo: 0 }];
    assert.equal(components(snapshot, 'SA', acled).conflict, 0);
    assert.equal(components(snapshot, 'FR', acled).unrest, 0);
  });

  it('counts a live GDELT baseline toward realtime conflict coverage', () => {
    assert.equal(countCiiRealtimeSignalDensityCoverage([], aux(), NOW), 0);
    assert.equal(countCiiRealtimeSignalDensityCoverage([], aux(seed({ US: { conflict: CONFLICT.US_OCT14 } })), NOW), 1);
  });

  it('parses only well-formed country rows from the snapshot', () => {
    const parsed = gdeltCountryEventsFromSeed({
      byCountry: {
        SA: { conflict: { current: 173, baselineMedian: 52 }, protest: { current: 'x', baselineMedian: 0 } },
        us: { conflict: { current: 1, baselineMedian: 1 } },
        IR: { conflict: { current: -1, baselineMedian: 1 } },
        IL: { conflict: { current: 5, baselineMedian: null } },
      },
      baselineReady: true,
      currentComplete: true,
      updatedAt: NOW,
    }, NOW);
    assert.deepEqual(Object.keys(parsed?.byCountry ?? {}).sort(), ['IL', 'SA']);
    assert.equal(parsed?.byCountry.SA?.protest, null);
    assert.equal(gdeltCountryEventsFromSeed(null, NOW), null);
    assert.equal(gdeltCountryEventsFromSeed({ byCountry: [], baselineReady: true, updatedAt: NOW }, NOW), null);
  });
});

// A month of strikes raises a country's own 28-day median, so escalation reads
// the campaign as calm (Saudi Conflict was 0 on Oct 19 under v10). The level
// term scores the share of a country's last seven complete days of coverage
// that is conflict- or protest-coded; as a share, media volume cancels out.
// Fixtures: real seven-day counts from summarizeCountryEvents over the
// replayed Sep 10 - Oct 19 2026 exports.
const WEEK = {
  SA_OCT19: { articles: 2147, conflict: 628, protest: 10 }, // 29% conflict
  SA_OCT05: { articles: 1758, conflict: 258, protest: 3 }, // 15%, before the strikes
  YE_OCT19: { articles: 774, conflict: 304, protest: 2 }, // 39%
  IL_OCT19: { articles: 3604, conflict: 838, protest: 70 }, // 23%
  US_OCT19: { articles: 40207, conflict: 5219, protest: 485 }, // 13%: crime and policing
  GB_OCT19: { articles: 8514, conflict: 781, protest: 83 }, // 9%
  CN_OCT19: { articles: 3303, conflict: 156, protest: 25 }, // 5%
  FR_OCT19: { articles: 2164, conflict: 253, protest: 172 }, // 7.9% protest
  BR_OCT19: { articles: 500, conflict: 30, protest: 14 }, // 2.8% protest
  MM_OCT19: { articles: 47, conflict: 5, protest: 1 }, // too few articles to read a share
};

describe('CII Conflict and Unrest from the sustained GDELT level while ACLED is dark', () => {
  it('scores a sustained campaign that has already raised its own norm', () => {
    // SA's last 24h sit at its (raised) median: escalation 0.
    const atNorm = { current: 90, baselineMedian: 95 };
    assert.equal(gdeltEscalationScore(atNorm), 0);
    assert.ok(gdeltLevelScore(WEEK.SA_OCT19, 'conflict') >= 25);
    assert.ok(components(seed({ SA: { conflict: atNorm, week: WEEK.SA_OCT19 } }), 'SA').conflict >= 25);
    assert.ok(gdeltLevelScore(WEEK.YE_OCT19, 'conflict') >= 45);
    assert.ok(gdeltLevelScore(WEEK.IL_OCT19, 'conflict') >= 15);
  });

  it('reads the week before the strikes as near calm', () => {
    assert.ok(gdeltLevelScore(WEEK.SA_OCT05, 'conflict') <= 5);
  });

  it('keeps the US, GB and China at zero on both terms', () => {
    for (const week of [WEEK.US_OCT19, WEEK.GB_OCT19, WEEK.CN_OCT19]) {
      assert.equal(gdeltLevelScore(week, 'conflict'), 0, JSON.stringify(week));
      assert.equal(gdeltLevelScore(week, 'protest'), 0, JSON.stringify(week));
    }
    const snapshot = seed({ US: { week: WEEK.US_OCT19 }, GB: { week: WEEK.GB_OCT19 }, CN: { week: WEEK.CN_OCT19 } });
    for (const code of ['US', 'GB', 'CN']) assert.deepEqual(components(snapshot, code), { conflict: 0, unrest: 0 });
  });

  it('scores a sustained protest movement on Unrest, and a protest share near the floor barely', () => {
    assert.ok(gdeltLevelScore(WEEK.FR_OCT19, 'protest') >= 40);
    assert.ok(components(seed({ FR: { week: WEEK.FR_OCT19 } }), 'FR').unrest >= 40);
    assert.ok(gdeltLevelScore(WEEK.BR_OCT19, 'protest') <= 10);
  });

  it('saturates at the shared GDELT cap', () => {
    assert.equal(gdeltLevelScore({ articles: 1000, conflict: 900, protest: 900 }, 'conflict'), CII_GDELT_ESCALATION_CAP);
    assert.equal(gdeltLevelScore({ articles: 1000, conflict: 900, protest: 900 }, 'protest'), CII_GDELT_ESCALATION_CAP);
  });

  it('does not read a share from too few articles', () => {
    assert.ok(WEEK.MM_OCT19.articles < CII_GDELT_LEVEL_MIN_ARTICLES);
    const smallButHot = { articles: CII_GDELT_LEVEL_MIN_ARTICLES - 1, conflict: 150, protest: 150 };
    assert.equal(gdeltLevelScore(smallButHot, 'conflict'), 0);
    assert.equal(gdeltLevelScore(smallButHot, 'protest'), 0);
    assert.ok(gdeltLevelScore({ ...smallButHot, articles: CII_GDELT_LEVEL_MIN_ARTICLES }, 'conflict') > 0);
    assert.equal(gdeltLevelScore(null, 'conflict'), 0);
  });

  it('takes the larger of escalation and level, never their sum', () => {
    const spike = { current: 173, baselineMedian: 52 }; // Riyadh, Oct 12
    const escalation = gdeltEscalationScore(spike);
    const level = gdeltLevelScore(WEEK.SA_OCT19, 'conflict');
    assert.ok(escalation > 0 && level > 0);
    assert.equal(components(seed({ SA: { conflict: spike, week: WEEK.SA_OCT19 } }), 'SA').conflict, Math.max(escalation, level));
  });

  it('gates the level on ACLED being dark, a fresh snapshot and a ready week', () => {
    const row = { SA: { week: WEEK.SA_OCT19 } };
    assert.ok(components(seed(row), 'SA').conflict > 0);
    const acled = [{ country: 'Ukraine', event_type: 'Battles', fatalities: 0, daysAgo: 0 }];
    assert.equal(components(seed(row), 'SA', acled).conflict, 0);
    assert.equal(components(seed(row, { updatedAt: NOW - CII_GDELT_ESCALATION_MAX_AGE_MS - 1 }), 'SA').conflict, 0);
    assert.equal(components(seed(row, { weekReady: false }), 'SA').conflict, 0);
  });

  it('scores the level before the 21-day baseline exists, while escalation waits for it', () => {
    // Production on deploy day: the materializer had 7 of the 21 baseline days,
    // so baselineReady was false, but the seven days through yesterday were
    // complete. The level reads only those days; escalation needs the norm.
    const spike = { current: 173, baselineMedian: 52 }; // Riyadh, Oct 12
    const early = seed({ SA: { conflict: spike, week: WEEK.SA_OCT19 } }, { baselineReady: false });
    assert.equal(components(early, 'SA').conflict, gdeltLevelScore(WEEK.SA_OCT19, 'conflict'));
    assert.ok(components(early, 'SA').conflict > 0);
    // The level reads complete days only, so an incomplete current window does not void it.
    const outage = seed({ SA: { conflict: spike, week: WEEK.SA_OCT19 } }, { currentComplete: false });
    assert.equal(components(outage, 'SA').conflict, gdeltLevelScore(WEEK.SA_OCT19, 'conflict'));
    // Escalation alone (no week) still needs the baseline and a complete window.
    assert.equal(components(seed({ SA: { conflict: spike } }, { baselineReady: false }), 'SA').conflict, 0);
    assert.equal(components(seed({ SA: { conflict: spike } }, { currentComplete: false }), 'SA').conflict, 0);
    // A week-only snapshot is a live GDELT input for realtime conflict coverage.
    assert.equal(countCiiRealtimeSignalDensityCoverage([], aux(early), NOW), 1);
  });

  it('reads exactly what the materializer publishes', () => {
    // Producer -> reader contract: summarizeCountryEvents' week reaches the
    // scorer intact and scores; a snapshot without weekReady scores no level.
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const days: Record<string, unknown> = {};
    for (let i = 1; i <= 29; i++) {
      days[day(NOW - i * 86_400_000)] = { cohorts: 96, countries: { SA: [300, 90, 1], US: [6000, 780, 70] } };
    }
    days[day(NOW)] = { cohorts: 48, countries: { SA: [150, 45, 0], US: [3000, 390, 35] } };
    const summary = summarizeCountryEvents({ cursor: '20261019114500', days }, NOW);
    assert.equal(summary.weekReady, true);
    const parsed = gdeltCountryEventsFromSeed({ ...summary, updatedAt: NOW }, NOW);
    assert.deepEqual(parsed?.byCountry.SA?.week, { articles: 2100, conflict: 630, protest: 7 });
    // 30% conflict, at its own norm: the level carries it; the US at 13% stays 0.
    assert.equal(gdeltEscalationScore(parsed?.byCountry.SA?.conflict), 0);
    const snapshot = { ...summary, updatedAt: NOW - 60_000 };
    assert.ok(components(snapshot, 'SA').conflict > 0);
    assert.equal(components(snapshot, 'US').conflict, 0);
    assert.equal(components({ ...snapshot, weekReady: false }, 'SA').conflict, 0);
  });

  it('parses only a well-formed week', () => {
    const parse = (week: unknown) => gdeltCountryEventsFromSeed({
      byCountry: { SA: { conflict: QUIET, protest: QUIET, week } },
      baselineReady: true, currentComplete: true, weekReady: true, updatedAt: NOW,
    }, NOW)?.byCountry.SA?.week ?? null;
    assert.deepEqual(parse(WEEK.SA_OCT19), WEEK.SA_OCT19);
    for (const bad of [null, { articles: 10, conflict: 11, protest: 0 }, { articles: -1, conflict: 0, protest: 0 },
      { articles: 10, conflict: '3', protest: 0 }, { articles: 10, conflict: 3 }]) {
      assert.equal(parse(bad), null, JSON.stringify(bad));
    }
  });
});
