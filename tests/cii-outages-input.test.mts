/**
 * Internet outages (`infra:outages:v1`) as a CII input.
 *
 * The scorer read `countryCode`, but scripts/seed-internet-outages.mjs wrote
 * only the country's display name, so no production record ever mapped (0 of
 * 15 on 2026-10-23) and input health called the dead reader "quiet". The rules
 * pinned here:
 *   1. every record maps to an ISO2 code through one shared resolver, whether
 *      it carries the seeder's `countryCode` or only a legacy `country` name;
 *   2. only causes that measure in-country instability score (government-
 *      directed shutdowns and military action), and only while the outage
 *      overlaps the scoring window;
 *   3. a reader that maps 0 of N non-empty records is unusable, not quiet (P7b).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessCiiInputAvailability,
  ciiInputExclusions,
  computeCiiScoreTable,
  outageCountryCode,
  outageVerdict,
  withCiiInputQuietClocks,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_OUTAGE_SCORED_CAUSES, CII_OUTAGE_WINDOW_MS } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

const NOW = Date.parse('2026-10-23T10:49:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Outage = Record<string, unknown>;

/** A record as the seeder published it before this fix: a name, no countryCode. */
const legacy = (country: string, cause: string, severity: string, detectedAt: number, endedAt = 0): Outage => ({
  id: `cf-${country}-${detectedAt}`, country, severity: `OUTAGE_SEVERITY_${severity}`, cause, detectedAt, endedAt,
});

function score(outages: Outage[] | null) {
  return computeCiiScoreTable({ outages: outages == null ? null : { outages } }, { nowMs: NOW, iranEventsEnabled: true });
}
const outageBoost = (outages: Outage[] | null, code: string) =>
  score(outages).rows.find((row) => row.region === code)!.parts.outageBoost;
const health = (outages: Outage[] | null) => {
  const table = score(outages);
  return assessCiiInputAvailability([], table.aux, NOW, false).outages;
};

describe('CII internet outages input', () => {
  it('maps a legacy name-only record and a seeder countryCode record to the same ISO2', () => {
    assert.equal(outageCountryCode({ country: 'Iraq' }), 'IQ');
    assert.equal(outageCountryCode({ country: 'Russian Federation' }), 'RU');
    assert.equal(outageCountryCode({ country: 'Swaziland' }), 'SZ');
    assert.equal(outageCountryCode({ countryCode: 'IQ', country: 'Iraq' }), 'IQ');
    assert.equal(outageCountryCode({ country_code: 'ru' }), 'RU');
    // The code wins over the name: the name is display text.
    assert.equal(outageCountryCode({ countryCode: 'SY', country: 'Syrian Arab Republic' }), 'SY');
    assert.equal(outageCountryCode({ country: 'Atlantis' }), null);
    assert.equal(outageCountryCode({ countryCode: 'ZZ' }), null, 'an unassigned code is not a country');
    assert.equal(outageCountryCode({}), null);
  });

  it('scores a government-directed shutdown in a record that carries only the country name', () => {
    assert.ok(outageBoost([legacy('Iraq', 'GOVERNMENT_DIRECTED', 'TOTAL', NOW - HOUR)], 'IQ') > 0);
  });

  it('scores a record that carries the seeder countryCode', () => {
    const record = { ...legacy('Russian Federation', 'MILITARY_ACTION', 'PARTIAL', NOW - 2 * DAY), countryCode: 'RU' };
    assert.ok(outageBoost([record], 'RU') > 0);
  });

  it('scores only government-directed shutdowns and military action', () => {
    assert.deepEqual([...CII_OUTAGE_SCORED_CAUSES].sort(), ['GOVERNMENT_DIRECTED', 'MILITARY_ACTION']);
    for (const cause of ['POWER_OUTAGE', 'CABLE_CUT', 'MAINTENANCE', 'NATURAL_DISASTER', 'TECHNICAL_PROBLEM', 'WEATHER', 'UNKNOWN', '']) {
      assert.equal(outageBoost([legacy('Iraq', cause, 'TOTAL', NOW - HOUR)], 'IQ'), 0, `${cause || '(no cause)'} must not score`);
    }
    assert.ok(outageBoost([legacy('Iraq', 'military_action', 'TOTAL', NOW - HOUR)], 'IQ') > 0, 'cause case does not matter');
  });

  it('scores an outage only while it overlaps the scoring window', () => {
    assert.equal(CII_OUTAGE_WINDOW_MS, 7 * DAY);
    const gov = (detectedAt: number, endedAt = 0) => outageBoost([legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', detectedAt, endedAt)], 'IQ');
    assert.ok(gov(NOW - 2 * HOUR, NOW - HOUR) > 0, 'ended an hour ago');
    assert.ok(gov(NOW - 8 * DAY, NOW - 6 * DAY) > 0, 'ended inside the window');
    assert.ok(gov(NOW - 20 * DAY) > 0, 'still ongoing (endedAt 0), started before the window');
    assert.equal(gov(NOW - 9 * DAY, NOW - 8 * DAY), 0, 'ended before the window');
    assert.equal(gov(NOW + HOUR), 0, 'not started yet');
    assert.equal(gov(0), 0, 'no start time');
    assert.equal(outageBoost([{ country: 'Iraq', severity: 'OUTAGE_SEVERITY_TOTAL', cause: 'GOVERNMENT_DIRECTED' }], 'IQ'), 0,
      'a record with no time cannot be placed in the window');
  });

  it('replays the 2026-10-23 production payload: only in-window, in-construct Tier-1 records score', () => {
    // The 15 records production held at 10:49Z, trimmed to the scored fields.
    const production = [
      legacy('Syria', 'MAINTENANCE', 'PARTIAL', Date.parse('2026-10-19T21:00Z'), Date.parse('2026-10-19T21:45Z')),
      legacy('Sri Lanka', 'POWER_OUTAGE', 'TOTAL', Date.parse('2026-10-17T06:00Z'), Date.parse('2026-10-17T17:00Z')),
      legacy('Namibia', 'POWER_OUTAGE', 'TOTAL', Date.parse('2026-10-14T23:30Z'), Date.parse('2026-10-14T23:45Z')),
      legacy('Uruguay', 'CABLE_CUT', 'MAJOR', Date.parse('2026-10-13T19:00Z'), Date.parse('2026-10-14T00:00Z')),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-10-10T02:45Z'), Date.parse('2026-10-10T03:45Z')),
      legacy('Panama', 'NATURAL_DISASTER', 'TOTAL', Date.parse('2026-10-09T18:00Z'), Date.parse('2026-10-10T04:00Z')),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-10-08T03:30Z'), Date.parse('2026-10-08T04:15Z')),
      legacy('Russian Federation', 'MILITARY_ACTION', 'PARTIAL', Date.parse('2026-10-07T22:30Z'), 0),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-10-06T02:45Z'), Date.parse('2026-10-06T04:15Z')),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-10-04T02:45Z'), Date.parse('2026-10-04T11:45Z')),
      legacy('Haiti', 'CABLE_CUT', 'PARTIAL', Date.parse('2026-10-03T13:30Z'), Date.parse('2026-10-04T18:15Z')),
      legacy('Swaziland', 'POWER_OUTAGE', 'TOTAL', Date.parse('2026-09-29T11:00Z'), Date.parse('2026-09-29T12:15Z')),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-09-28T03:30Z'), Date.parse('2026-09-28T03:45Z')),
      legacy('Iraq', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-09-26T03:30Z'), Date.parse('2026-09-26T03:45Z')),
      legacy('Ethiopia', 'GOVERNMENT_DIRECTED', 'MAJOR', Date.parse('2026-09-24T21:00Z'), Date.parse('2026-10-04T08:00Z')),
    ];
    assert.equal(production.filter((o) => outageCountryCode(o)).length, 15, 'every record maps');
    const rows = score(production).rows;
    const moved = rows.filter((row) => row.parts.outageBoost > 0).map((row) => [row.region, row.parts.outageBoost]);
    // RU: the ongoing military-action outage (PARTIAL = 5). Iraq's government-
    // directed exam shutdowns ended 13+ days ago; Syria's is maintenance.
    assert.deepEqual(moved, [['RU', 5]]);
    assert.equal(health(production), 'live');
  });

  it('reports a reader that maps 0 of N records as unusable, not quiet (P7b)', () => {
    assert.equal(health([legacy('Atlantis', 'GOVERNMENT_DIRECTED', 'TOTAL', NOW - HOUR), { severity: 'OUTAGE_SEVERITY_MAJOR' }]), 'unusable');
  });

  it('keeps quiet for mapped records that score nothing, and an empty payload is quiet', () => {
    assert.equal(health([legacy('Namibia', 'POWER_OUTAGE', 'TOTAL', NOW - HOUR)]), 'quiet');
    assert.equal(health([legacy('Iraq', 'POWER_OUTAGE', 'TOTAL', NOW - HOUR)]), 'quiet');
    assert.equal(health([]), 'quiet');
    assert.equal(health(null), 'missing');
  });
});

/**
 * Exam shutdowns (owner ruling, 2026-10-23). States cut the Internet during
 * national exams on a published calendar (Iraq, Syria, Algeria, Sudan and
 * others), so these shutdowns say nothing about instability. Cloudflare Radar
 * files them as GOVERNMENT_DIRECTED like any other shutdown and has no
 * structured marker for them, so they are recognised lexically from the
 * description and title (CII_OUTAGE_EXAM_TERMS), and every exclusion is
 * reported on the outages input-health entry.
 */
describe('CII internet outages: exam shutdowns are excluded', () => {
  const at = (iso: string) => Date.parse(iso);
  const iraqExam = (id: string, description: string, start: string, end: string): Outage => ({
    id, title: 'Internet disruption in Iraq', description, country: 'Iraq', countryCode: 'IQ',
    severity: 'OUTAGE_SEVERITY_MAJOR', cause: 'GOVERNMENT_DIRECTED', detectedAt: at(start), endedAt: at(end),
  });
  // The six production records of 2026-09-26 to 2026-10-10, as the seeder publishes them.
  const IRAQ_EXAM_RECORDS = [
    iraqExam('cf-1687', 'Exam shutdown', '2026-10-10T02:45Z', '2026-10-10T03:45Z'),
    iraqExam('cf-1683', 'Exam shutdown', '2026-10-08T03:30Z', '2026-10-08T04:15Z'),
    iraqExam('cf-1682', 'Exam shutdown', '2026-10-06T02:45Z', '2026-10-06T04:15Z'),
    iraqExam('cf-1680', 'Exam shutdown', '2026-10-04T02:45Z', '2026-10-04T11:45Z'),
    iraqExam('cf-1677', 'Exam shutdown (special round started Sep 26 and runs through Oct 10)', '2026-09-28T03:30Z', '2026-09-28T03:45Z'),
    iraqExam('cf-1676', 'Exam shutdown (special round started Sep 26 and runs through Oct 10)', '2026-09-26T03:30Z', '2026-09-26T03:45Z'),
  ];
  const tableAt = (outages: Outage[], nowMs: number) =>
    computeCiiScoreTable({ outages: { outages } }, { nowMs, iranEventsEnabled: true });
  const boostAt = (outages: Outage[], code: string, nowMs: number) =>
    tableAt(outages, nowMs).rows.find((row) => row.region === code)!.parts.outageBoost;
  /** The exclusion report for these records: a count and up to 5 samples to audit. */
  const examExclusion = (records: Outage[]) => ({
    outages: {
      examShutdown: {
        count: records.length,
        samples: records.slice(0, 5).map((r) => ({ id: String(r.id ?? ''), title: String(r.title ?? ''), description: String(r.description ?? '') })),
      },
    },
  });
  const shutdown = (nowMs: number, description: string): Outage => ({
    countryCode: 'IQ', cause: 'GOVERNMENT_DIRECTED', severity: 'OUTAGE_SEVERITY_MAJOR', detectedAt: nowMs - HOUR, endedAt: 0, description,
  });

  it('excludes each of the six production Iraq exam shutdowns while it is in the window', () => {
    for (const record of IRAQ_EXAM_RECORDS) {
      const during = Number(record.detectedAt) + 10 * 60 * 1000;
      assert.equal(outageVerdict(record, during), 'exam', `${record.id} must be read as an exam shutdown`);
      assert.equal(boostAt([record], 'IQ', during), 0, `${record.id} must not score`);
    }
    // All six together on the last day of the round: nothing scores, and the
    // four inside the 7-day window are reported as removed by the exam rule.
    const end = at('2026-10-10T04:00Z');
    assert.equal(boostAt(IRAQ_EXAM_RECORDS, 'IQ', end), 0);
    assert.deepEqual(ciiInputExclusions(tableAt(IRAQ_EXAM_RECORDS, end).aux, end), examExclusion(IRAQ_EXAM_RECORDS.slice(0, 4)));
  });

  it('still scores a government-directed shutdown with no exam wording', () => {
    const now = at('2026-10-23T10:49Z');
    const protest = shutdown(now, 'Internet restricted amid anti-government protests');
    assert.equal(outageVerdict(protest, now), 'scored');
    assert.equal(boostAt([protest], 'IQ', now), 15);
    const tigray = { ...shutdown(now, "Internet restricted after fighting breaks out in Ethiopia's Tigray region"), countryCode: 'ET' };
    assert.equal(outageVerdict(tigray, now), 'scored');
  });

  it('excludes a synthetic Algeria baccalaureate shutdown, in French, English or Arabic', () => {
    const now = at('2026-06-15T09:00Z');
    const algeria = (description: string): Outage => ({
      ...shutdown(now, description), countryCode: 'DZ', country: 'Algeria', severity: 'OUTAGE_SEVERITY_TOTAL', title: 'Internet disruption in Algeria',
    });
    for (const description of [
      "Coupure d'Internet pendant les épreuves du baccalauréat",
      'Nationwide shutdown during baccalaureate exams',
      'قطع الإنترنت خلال امتحانات البكالوريا',
      'انقطاع الإنترنت بسبب الامتحان',
    ]) {
      assert.equal(outageVerdict(algeria(description), now), 'exam', description);
    }
    const bac = algeria('Coupure pendant le baccalauréat');
    assert.deepEqual(ciiInputExclusions(tableAt([bac], now).aux, now), examExclusion([bac]));
  });

  it('excludes Kurdish, French "examen", plural and "examination" wordings', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'بڕینی ئینتەرنێت لە کاتی تاقیکردنەوەکان',
      "Coupure d'Internet le jour de l'examen",
      'Internet shutdown in Kurdistan region to prevent cheating on exams',
      'Suspension of Internet service during Sudanese Certificate Examination sessions',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'exam', description);
    }
    assert.equal(outageVerdict({ ...shutdown(now, ''), title: 'Exam shutdown in Syria' }, now), 'exam', 'the title is read too');
  });

  it('matches exam terms as words, not inside unrelated words', () => {
    const now = at('2026-06-15T09:00Z');
    assert.equal(outageVerdict(shutdown(now, 'For example, mobile networks were cut after the vote'), now), 'scored');
    assert.equal(outageVerdict(shutdown(now, 'Regulators examined the shutdown order'), now), 'scored');
  });

  it('still scores the Russian military-action outage', () => {
    const now = at('2026-10-23T10:49Z');
    const ru: Outage = {
      id: 'cf-1700', country: 'Russian Federation', countryCode: 'RU', cause: 'MILITARY_ACTION', severity: 'OUTAGE_SEVERITY_PARTIAL',
      detectedAt: at('2026-10-07T22:30Z'), endedAt: 0, title: 'Internet disruption in Russian Federation',
      description: "Yandex, Russia's biggest internet company, shut down its data centers in Sasovo, Ryazan, and later in Vladimir after drone strikes damaged both facilities.",
    };
    assert.equal(outageVerdict(ru, now), 'scored');
    assert.equal(boostAt([ru], 'RU', now), 5);
    assert.deepEqual(ciiInputExclusions(tableAt([ru], now).aux, now), {});
  });

  it('reports exclusions on the outages input-health entry, and nothing when none were made', () => {
    const end = at('2026-10-10T04:00Z');
    const aux = tableAt(IRAQ_EXAM_RECORDS, end).aux;
    const reports = withCiiInputQuietClocks(assessCiiInputAvailability([], aux, end, false), null, end, { exclusions: ciiInputExclusions(aux, end) });
    assert.deepEqual(reports.outages, { state: 'quiet', quietSince: end, excluded: examExclusion(IRAQ_EXAM_RECORDS.slice(0, 4)).outages });
    assert.equal('excluded' in reports.ucdp, false);
  });

  it('keeps at most 5 samples, and caps each description, while counting every exclusion', () => {
    const now = at('2026-06-15T09:00Z');
    const many = Array.from({ length: 8 }, (_, i) => ({ ...shutdown(now, `Exam shutdown ${'x'.repeat(400)}`), id: `cf-${i}`, title: `t${i}` }));
    const report = ciiInputExclusions(tableAt(many, now).aux, now).outages!.examShutdown!;
    assert.equal(report.count, 8);
    assert.deepEqual(report.samples.map((x) => x.id), ['cf-0', 'cf-1', 'cf-2', 'cf-3', 'cf-4']);
    assert.ok(report.samples.every((x) => x.description.length <= 200));
  });

  // Independent review of def0c29e3: an exam mentioned beside unrest is not a routine exam shutdown.
  it('scores a shutdown whose exam wording comes with unrest, election, conflict or military wording', () => {
    const now = at('2026-10-23T10:49Z');
    for (const description of [
      'Internet cut after protests following exam results leak',
      'Internet shutdown during national exams in Ethiopia, protests continue in Amhara',
      'Exam shutdown extended as riots spread',
      'Coupure pendant le baccalauréat, manifestations à Alger',
      'قطع الإنترنت خلال الامتحانات وسط احتجاجات',
      'Exam shutdown during the election week',
      'Exams postponed and Internet cut amid fighting and a curfew',
      'بڕینی ئینتەرنێت لە کاتی تاقیکردنەوەکان و خۆپیشاندان',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'scored', description);
    }
    assert.equal(boostAt([shutdown(now, 'Internet cut after protests following exam results leak')], 'IQ', now), 15);
  });

  it('excludes Algeria "bac" and "BEM", Spanish "exámenes", Syria "secondary certificate", Iran "konkur" and "grade 12" exams', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Nationwide shutdown for the bac',
      'Coupure pendant le BAC 2026',
      "Coupure d'Internet pendant l'examen du BEM",
      'Corte de Internet durante los exámenes nacionales',
      'Internet cut during secondary certificate exams week',
      'Shutdown for the Secondary Certificate',
      'Mobile Internet cut during the Konkur',
      'Shutdown during Grade 12 national tests',
      'Shutdown during grade-12 tests',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'exam', description);
    }
  });

  // Round-2 review of 26a5dbdf3: an unrest term that is negated is not unrest.
  it('ignores negated unrest wording, so a routine exam shutdown stays excluded', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Exam season shutdown, no protests reported',
      'Exam shutdown to prevent cheating; no conflict',
      'Exam shutdown carried out without any violence',
      'Exam shutdown; there was not a single protest',
      'Exam shutdown amid a lack of unrest',
      'Coupure pendant le baccalauréat, aucune manifestation signalée',
      'Coupure pendant le baccalauréat, sans manifestations',
      'قطع الإنترنت خلال الامتحانات دون احتجاجات',
      'قطع الإنترنت خلال الامتحانات ولا توجد احتجاجات',
      'بڕینی ئینتەرنێت لە کاتی تاقیکردنەوەکان بێ خۆپیشاندان',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'exam', description);
    }
  });

  it('still keeps exam shutdowns with non-negated unrest, including after a negation elsewhere', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Exam shutdown as protests continue',
      'No exam was held; protests spread across the capital',
      'Exam shutdown, no reports of damage, but protests in the south',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'scored', description);
    }
  });

  it('counts "protested", a labour strike, a rally, militants, violence and a security operation as unrest', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Exam shutdown after students protested the results',
      'Exam shutdown during the teachers’ strike',
      'Exam shutdown as unions call strikes',
      'Exam shutdown ahead of an opposition rally',
      'Exam shutdown after militants attacked a checkpoint',
      'Exam shutdown following violence in the north',
      'Exam shutdown during a security operation in the region',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'scored', description);
    }
  });

  it('does not read "airstrike" or "rallying" as unrest', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Exam shutdown; airstrike coverage unrelated',
      'Exam shutdown; operators rallying to restore service',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'exam', description);
    }
  });

  it('matches "bac" and "BEM" only as whole words', () => {
    const now = at('2026-06-15T09:00Z');
    for (const description of [
      'Bacteria contamination closed a data centre',
      'Backbone cut ordered by the regulator',
      'Shutdown ordered by the BEMA authority',
      'Grade 120 cable damaged',
    ]) {
      assert.equal(outageVerdict(shutdown(now, description), now), 'scored', description);
    }
  });

  it('allows five minutes of clock skew on a start time ahead of the scorer', () => {
    const now = at('2026-10-23T10:49Z');
    const ahead = (ms: number) => ({ ...shutdown(now, 'Shutdown amid protests'), detectedAt: now + ms });
    assert.equal(outageVerdict(ahead(60 * 1000), now), 'scored', 'a minute ahead is skew');
    assert.equal(outageVerdict(ahead(5 * 60 * 1000), now), 'scored', 'five minutes ahead is still skew');
    assert.equal(outageVerdict(ahead(6 * 60 * 1000), now), 'window', 'six minutes ahead is a future record');
  });
});
