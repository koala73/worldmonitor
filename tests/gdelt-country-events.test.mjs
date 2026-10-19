import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryEventsDayStamps,
  COUNTRY_EVENTS_MIN_BASELINE_DAYS,
  COUNTRY_EVENTS_REPAIR_BACKOFF_MS,
  mergeCountryEventsBuckets,
  parseCountryEventsExport,
  planCountryEventsRepair,
  rebuildCountryEventsDay,
  replaceCountryEventsDays,
  summarizeCountryEvents,
} from '../scripts/_gdelt-country-events.mjs';
import { dyadDayExportTimestamps } from '../scripts/_gdelt-dyad-tension.mjs';

const DAY = 86_400_000;

function row({ id = '1', root = '1', quad = '4', rootCode = '19', fips = 'SA', url = 'https://a.example/1' } = {}) {
  const fields = Array(61).fill('');
  fields[0] = id;
  fields[25] = root;
  fields[28] = rootCode;
  fields[29] = quad;
  fields[53] = fips;
  fields[60] = url;
  return fields.join('\t');
}

function dayOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function fullDay(countries) {
  return { cohorts: 96, countries };
}

describe('parseCountryEventsExport', () => {
  it('counts distinct root-event articles per ISO2 country, conflict and protest separately', () => {
    const csv = [
      row({ id: '1', url: 'https://a.example/strike' }),
      row({ id: '2', url: 'https://a.example/strike', rootCode: '18' }), // same article, second event
      row({ id: '3', url: 'https://b.example/talks', quad: '1', rootCode: '04' }), // cooperative
      row({ id: '4', url: 'https://c.example/other', root: '0' }), // not a root event
      row({ id: '5', fips: 'IS', url: 'https://d.example/il' }), // FIPS IS is Israel
      row({ id: '6', fips: 'ZZ', url: 'https://e.example/x' }), // unknown location
      row({ id: '7', fips: 'FR', quad: '3', rootCode: '14', url: 'https://f.example/riot' }), // protest
      row({ id: '8', fips: 'FR', quad: '3', rootCode: '14', url: 'https://f.example/riot' }), // same article
      'short\tline',
    ].join('\n');
    assert.deepEqual(parseCountryEventsExport(csv), { SA: [2, 1, 0], IL: [1, 1, 0], FR: [1, 0, 1] });
  });

  it('ignores material conflict outside CAMEO roots 18, 19 and 20', () => {
    const csv = [row({ id: '1', rootCode: '17', url: 'https://a.example/coerce' })].join('\n');
    assert.deepEqual(parseCountryEventsExport(csv), { SA: [1, 0, 0] });
  });
});

describe('mergeCountryEventsBuckets', () => {
  const now = Date.parse('2026-10-12T20:00:00Z');

  it('adds each cohort once, behind a cursor, into its UTC day', () => {
    const batch = { timestamp: '20261012194500', countries: { SA: [10, 4, 1] } };
    const first = mergeCountryEventsBuckets(null, [batch], now);
    assert.deepEqual(first.days['2026-10-12'], { cohorts: 1, countries: { SA: [10, 4, 1] } });
    const replay = mergeCountryEventsBuckets(first, [batch], now);
    assert.deepEqual(replay.days['2026-10-12'], first.days['2026-10-12'], 'a replayed cohort is not counted twice');
    assert.equal(replay.cursor, '20261012194500');
  });

  it('drops days that left the 30-day window', () => {
    const merged = mergeCountryEventsBuckets({ cursor: '', days: { '2026-09-01': fullDay({ SA: [1, 1] }) } }, [], now);
    assert.deepEqual(merged.days, {});
  });

  it('rejects a cohort stamped beyond the publication lead', () => {
    assert.throws(() => mergeCountryEventsBuckets(null, [{ timestamp: '20261013200000', countries: {} }], now));
  });
});

describe('country-events repair planning', () => {
  const now = Date.parse('2026-10-12T20:00:00Z');
  // Today holds every cohort published through the 19:45 cursor (80).
  const snapshot = {
    cursor: '20261012194500',
    days: { '2026-10-12': { cohorts: 80, countries: {} }, '2026-10-11': fullDay({}) },
  };

  it('plans the incomplete past days newest first, and not a complete today', () => {
    const plan = planCountryEventsRepair(snapshot, now, 3);
    assert.deepEqual(plan, ['2026-10-10', '2026-10-09', '2026-10-08']);
  });

  it('backs off a day whose repair failed', () => {
    const failed = { ...snapshot, repairFailures: { '2026-10-10': now } };
    assert.deepEqual(planCountryEventsRepair(failed, now, 1), ['2026-10-09']);
    assert.deepEqual(planCountryEventsRepair(failed, now + COUNTRY_EVENTS_REPAIR_BACKOFF_MS, 1), ['2026-10-10']);
  });

  it('rebuilds a day only from its exact 96 cohorts and replaces it wholesale', () => {
    const stamps = dyadDayExportTimestamps('2026-10-10');
    assert.throws(() => rebuildCountryEventsDay('2026-10-10', stamps.slice(1).map((timestamp) => ({ timestamp, countries: {} }))));
    const day = rebuildCountryEventsDay('2026-10-10', stamps.map((timestamp) => ({ timestamp, countries: { SA: [2, 1, 0] } })));
    assert.deepEqual(day, { cohorts: 96, countries: { SA: [192, 96, 0] } });
    const replaced = replaceCountryEventsDays(snapshot, { '2026-10-10': day, '2026-10-12': day }, now);
    assert.equal(replaced.days['2026-10-10'].countries.SA[1], 96);
    assert.equal(replaced.days['2026-10-12'].cohorts, 80, 'a complete live day is never replaced');
  });

  // The live downloader keeps only the newest 8 cohorts per kind, so an outage
  // longer than 2h leaves a hole in today that the cursor has already passed.
  it('plans today when an outage left it short of the cohorts through the cursor', () => {
    const outage = {
      cursor: '20261012194500', // 80 cohorts of today are published through 19:45
      days: {
        '2026-10-12': { cohorts: 8, countries: { SA: [80, 40, 0] } },
        '2026-10-11': fullDay({}),
      },
    };
    assert.deepEqual(planCountryEventsRepair(outage, now, 2), ['2026-10-12', '2026-10-10']);
    assert.deepEqual(planCountryEventsRepair({ ...outage, days: { ...outage.days, '2026-10-12': { cohorts: 80, countries: {} } } }, now, 1), ['2026-10-10']);
  });

  it('rebuilds today from exactly its cohorts through the cursor and replaces the short bucket', () => {
    const cursor = '20261012194500';
    const stamps = countryEventsDayStamps('2026-10-12', cursor);
    assert.equal(stamps.length, 80);
    assert.equal(stamps.at(-1), cursor);
    const day = rebuildCountryEventsDay('2026-10-12', stamps.map((timestamp) => ({ timestamp, countries: { SA: [1, 1, 0] } })), cursor);
    assert.deepEqual(day, { cohorts: 80, countries: { SA: [80, 80, 0] } });
    assert.throws(() => rebuildCountryEventsDay('2026-10-12', stamps.slice(1).map((timestamp) => ({ timestamp, countries: {} })), cursor));
    const outage = { cursor, days: { '2026-10-12': { cohorts: 8, countries: { SA: [8, 8, 0] } } } };
    assert.equal(replaceCountryEventsDays(outage, { '2026-10-12': day }, now).days['2026-10-12'].cohorts, 80);
  });
});

describe('summarizeCountryEvents', () => {
  // 18:00 UTC: today holds 72 cohorts, so 24 of yesterday's 96 complete the window.
  const now = Date.parse('2026-10-12T18:00:00Z');

  function history({ baselineValue = 10, baselineDays = 28, yesterday = 40, today = 30 } = {}) {
    const days = {};
    for (let i = 2; i < 2 + baselineDays; i++) days[dayOf(now - i * DAY)] = fullDay({ SA: [100, baselineValue, 2], US: [5000, 400, 80] });
    days[dayOf(now - DAY)] = fullDay({ SA: [200, yesterday, 2], US: [5000, 400, 80] });
    days[dayOf(now)] = { cohorts: 72, countries: { SA: [150, today, 6], US: [3750, 300, 60] } };
    return { cursor: '20261012174500', days };
  }

  it('reports the last 24h against the median of the 28 days before yesterday', () => {
    const summary = summarizeCountryEvents(history(), now);
    assert.equal(summary.baselineReady, true);
    assert.equal(summary.baselineDays, 28);
    assert.equal(summary.currentCohorts, 96);
    assert.deepEqual(summary.byCountry.SA, {
      conflict: { current: 30 + 40 * 24 / 96, baselineMedian: 10 },
      protest: { current: 6 + 2 * 24 / 96, baselineMedian: 2 },
    });
    assert.deepEqual(summary.byCountry.US, {
      conflict: { current: 400, baselineMedian: 400 },
      protest: { current: 80, baselineMedian: 80 },
    });
  });

  it('never passes yesterday off as today after an outage', () => {
    // An outage dropped 64 of today's 72 published cohorts; the 8 kept carry a
    // spike. The current window is incomplete, not yesterday's quiet average.
    const snapshot = history();
    snapshot.days[dayOf(now)] = { cohorts: 8, countries: { SA: [80, 60, 0], US: [400, 30, 5] } };
    const summary = summarizeCountryEvents(snapshot, now);
    assert.equal(summary.currentComplete, false);
    assert.equal(summary.currentCohorts, 8 + 24, 'only the cohorts actually observed');
  });

  it('marks a complete current window as complete', () => {
    const summary = summarizeCountryEvents(history(), now);
    assert.equal(summary.currentComplete, true);
  });

  it('marks the window incomplete when the yesterday share it borrows is itself short', () => {
    const snapshot = history();
    snapshot.days[dayOf(now - DAY)] = { cohorts: 60, countries: { SA: [100, 20, 1] } };
    assert.equal(summarizeCountryEvents(snapshot, now).currentComplete, false);
  });

  it('has no baseline until three weeks of complete days exist', () => {
    const summary = summarizeCountryEvents(history({ baselineDays: COUNTRY_EVENTS_MIN_BASELINE_DAYS - 1 }), now);
    assert.equal(summary.baselineReady, false);
    assert.equal(summary.byCountry.SA.conflict.baselineMedian, null);
    assert.equal(summary.byCountry.SA.protest.baselineMedian, null);
  });

  it('excludes incomplete days from the baseline instead of reading them as calm', () => {
    const snapshot = history();
    snapshot.days[dayOf(now - 5 * DAY)] = { cohorts: 50, countries: {} };
    assert.equal(summarizeCountryEvents(snapshot, now).baselineDays, 27);
  });

  it('counts a quiet baseline day as zero for a country with no rows that day', () => {
    const snapshot = history();
    for (let i = 2; i < 17; i++) snapshot.days[dayOf(now - i * DAY)].countries = { US: [5000, 400, 80] };
    // 15 of 28 days are zero for SA, so the median is zero.
    assert.equal(summarizeCountryEvents(snapshot, now).byCountry.SA.conflict.baselineMedian, 0);
  });
});
