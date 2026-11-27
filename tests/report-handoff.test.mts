import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPORT_MAX_COUNTRIES,
  assessmentRequestText,
  reportHandoffFromScope,
} from '../shared/report-handoff.ts';
import { hasTravelRiskAssessment } from '../shared/travel-risk-access.ts';

const NAMES: Record<string, string> = { TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesia', LA: 'Laos' };
const nameOf = (code: string) => NAMES[code] ?? code;

test('the hand-off carries the chosen countries in order and the window', () => {
  const handoff = reportHandoffFromScope({
    countries: ['TH', 'VN', 'ID'],
    neighbours: true,
    start: '2026-11-14',
    end: '2026-11-18',
  });
  assert.deepEqual(handoff, {
    countries: ['TH', 'VN', 'ID'],
    omitted: [],
    dateFrom: '2026-11-14',
    dateTo: '2026-11-18',
  });
});

test('neighbours are not part of the hand-off, with or without the switch', () => {
  for (const neighbours of [true, false]) {
    assert.deepEqual(reportHandoffFromScope({ countries: ['TH'], neighbours }).countries, ['TH']);
  }
});

test('a focus without dates hands off no dates', () => {
  const handoff = reportHandoffFromScope({ countries: ['TH'], neighbours: false });
  assert.equal(handoff.dateFrom, null);
  assert.equal(handoff.dateTo, null);
});

test('a focus larger than the report takes keeps the first countries and names the rest', () => {
  const codes = ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA'];
  const handoff = reportHandoffFromScope({ countries: codes, neighbours: true });
  assert.equal(handoff.countries.length, REPORT_MAX_COUNTRIES);
  assert.deepEqual(handoff.countries, codes.slice(0, REPORT_MAX_COUNTRIES));
  assert.deepEqual(handoff.omitted, ['KH', 'LA']);
});

test('the hand-off does not alias the scope', () => {
  const scope = { countries: ['TH', 'VN'], neighbours: true };
  const handoff = reportHandoffFromScope(scope);
  handoff.countries.push('ID');
  assert.deepEqual(scope.countries, ['TH', 'VN']);
});

test('the request names the tool, each country with its code, and the window', () => {
  const text = assessmentRequestText(
    { countries: ['TH', 'VN', 'ID'], omitted: [], dateFrom: '2026-11-14', dateTo: '2026-11-18' },
    nameOf,
  );
  assert.match(text, /prepare_travel_risk_assessment/);
  assert.match(text, /Thailand \(TH\), Vietnam \(VN\), Indonesia \(ID\)/);
  assert.match(text, /2026-11-14 to 2026-11-18/);
});

test('the request states a one-sided window and leaves out a missing one', () => {
  const base = { countries: ['TH'], omitted: [] };
  assert.match(assessmentRequestText({ ...base, dateFrom: '2026-11-14', dateTo: null }, nameOf), /From 2026-11-14/);
  assert.match(assessmentRequestText({ ...base, dateFrom: null, dateTo: '2026-11-18' }, nameOf), /Until 2026-11-18/);
  assert.doesNotMatch(assessmentRequestText({ ...base, dateFrom: null, dateTo: null }, nameOf), /[Dd]ate/);
});

test('the request tells the assistant which countries it left out, as not requested', () => {
  const text = assessmentRequestText(
    { countries: ['TH'], omitted: ['LA', 'VN'], dateFrom: null, dateTo: null },
    nameOf,
  );
  assert.match(text, /Not part of this request \(an assessment covers at most 6 countries\): Laos \(LA\), Vietnam \(VN\)\./);
  assert.doesNotMatch(text.split('\n')[1]!, /Laos|Vietnam/);
});

test('the request has no omission line when nothing was left out', () => {
  const text = assessmentRequestText({ countries: ['TH'], omitted: [], dateFrom: null, dateTo: null }, nameOf);
  assert.doesNotMatch(text, /Not part of this request/);
});

const entitlement = (over: Partial<{ tier: number; travelRiskAssessment: boolean | undefined; validUntil: number }> = {}) => ({
  features: { tier: over.tier ?? 1, travelRiskAssessment: 'travelRiskAssessment' in over ? over.travelRiskAssessment : true },
  validUntil: over.validUntil ?? 2_000,
});

test('the travel risk predicate needs the named flag, a paid tier and an unexpired grant', () => {
  assert.equal(hasTravelRiskAssessment(entitlement(), 1_000), true);
  assert.equal(hasTravelRiskAssessment(entitlement({ travelRiskAssessment: false }), 1_000), false);
  assert.equal(hasTravelRiskAssessment(entitlement({ travelRiskAssessment: undefined }), 1_000), false);
  assert.equal(hasTravelRiskAssessment(entitlement({ tier: 0 }), 1_000), false);
  assert.equal(hasTravelRiskAssessment(entitlement({ validUntil: 999 }), 1_000), false);
  assert.equal(hasTravelRiskAssessment(null, 1_000), false);
  assert.equal(hasTravelRiskAssessment(undefined, 1_000), false);
});

test('the request carries the cities, per-country dates and task label typed in the dialog', () => {
  const name = (code: string) => ({ TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesia' } as Record<string, string>)[code]!;
  const text = assessmentRequestText({
    countries: ['TH', 'VN', 'ID'],
    omitted: [],
    dateFrom: '2026-12-01',
    dateTo: '2026-12-12',
    taskLabel: 'Regional site visits',
    details: {
      TH: { cities: ['Bangkok', 'Chiang Mai'], arrive: '2026-12-01', depart: '2026-12-05' },
      VN: { cities: [], arrive: null, depart: null },
      ID: { cities: ['Jakarta'], arrive: null, depart: '2026-12-12' },
    },
  }, name);
  assert.deepEqual(text.split('\n').slice(2), [
    'Date window: 2026-12-01 to 2026-12-12.',
    'Task label: Regional site visits.',
    'Thailand (TH): cities Bangkok, Chiang Mai; arrive 2026-12-01; depart 2026-12-05.',
    'Indonesia (ID): cities Jakarta; depart 2026-12-12.',
  ]);
});

test('a hand-off with no details reads exactly as before', () => {
  const text = assessmentRequestText({ countries: ['TH'], omitted: [], dateFrom: null, dateTo: null }, () => 'Thailand');
  assert.equal(text, 'Use the prepare_travel_risk_assessment tool to draft a travel risk assessment.\nCountries, in this order: Thailand (TH).');
});
