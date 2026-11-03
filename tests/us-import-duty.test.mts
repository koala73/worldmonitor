// Executable coverage for GetUsImportDuty and the chapter 99 index behind it.
//
// Every upstream body is a real USITC HTS response captured on 2026-10-10
// against 2026 HTS Revision 21 (tests/fixtures/us-hts/):
//  - chapter99-notes-subchapter-iii.html.gz: subchapter III of
//    getChapterNotes?doc=99, with tag attributes other than <li value> dropped
//    and every other inline tag replaced by a space. The index built from it
//    is byte-identical to the one built from the full 5.3 MB response.
//  - chapter99-headings.json: the 9903 heading rows from exportList that the
//    measure specs read, plus IEEPA, Section 122 and expired rows that must
//    be ignored.
//  - exportList-<hs6>.json: exportList for one subheading.
//
// The cases pin what the real schedule data showed:
//  - product coverage lives in the chapter 99 U.S. notes, not in the lines;
//  - the 2024 four-year review moved products from the note 20 lists into
//    note 31, so EVs pay 9903.91.03 and not List 3;
//  - the 2026 forced-labor action (note 52) is country-wide with product,
//    country and entry exemptions, and tops EU/Japan/Korea/Swiss/Taiwan rates
//    up to a combined floor;
//  - IEEPA headings are still printed but no longer collected.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

import {
  Chapter99Notes,
  ENTRY_CONDITIONS,
  EXEMPTIONS,
  LIST_DUTIES,
  US_HTS_CATALOG_KEY as SEED_CATALOG_KEY,
  US_HTS_COVERAGE_PREFIX as SEED_COVERAGE_PREFIX,
  buildUsDutyIndex,
  classifyCodes,
  makeCountryResolver,
  nextMarker,
  parseAdditionalRate,
  parseEffectiveWindow,
  usHtsCoverageKey as seedCoverageKey,
} from '../scripts/shared/us-hts-chapter99.mjs';
import {
  US_HTS_CATALOG_KEY,
  US_HTS_COVERAGE_PREFIX,
  columnTwoOverride,
  coverageFor,
  estimateRate,
  exportListRange,
  getUsImportDuty,
  parseHtsLines,
  parseSpecialRates,
  resolveAdditionalDuties,
  resolveBaseRate,
  usHtsCoverageKey,
  type UsDutyCatalog,
} from '../server/worldmonitor/trade/v1/get-us-import-duty';
import { validateGeneratedRequest } from '../server/request-validator';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';
import { getRequiredTier } from '../server/_shared/entitlement-check';

import type {
  ServerContext,
  UsAdditionalDuty,
} from '../src/generated/server/worldmonitor/trade/v1/service_server';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('../scripts/shared/country-name-to-iso2.cjs');
const UN_TO_ISO2 = require('../scripts/shared/un-to-iso2.json');

const ROUTE = '/api/trade/v1/get-us-import-duty';
const FIXTURES = resolve(import.meta.dirname, 'fixtures/us-hts');
const NOTES_HTML = gunzipSync(readFileSync(resolve(FIXTURES, 'chapter99-notes-subchapter-iii.html.gz'))).toString('latin1');
const HEADINGS = JSON.parse(readFileSync(resolve(FIXTURES, 'chapter99-headings.json'), 'utf8'));
const exportList = (hs6: string) => JSON.parse(readFileSync(resolve(FIXTURES, `exportList-${hs6}.json`), 'utf8'));
const NOW = new Date('2026-10-10T12:00:00Z');
const RELEASE = { name: '2026HTSRev21', startDate: '10/09/2026' };
const resolveCountry = makeCountryResolver(countryNameToIso2, UN_TO_ISO2);

const INDEX = buildUsDutyIndex({ notesHtml: NOTES_HTML, headingRows: HEADINGS, release: RELEASE, resolveCountry, now: NOW });
const CATALOG: UsDutyCatalog = { schema: INDEX.schema, release: INDEX.release, chapters: Object.keys(INDEX.coverage), measures: INDEX.measures };

/** Coverage entries for an exact provision: "id/role[/partial]". */
function entries(code: string): string[] {
  return (INDEX.coverage[code.slice(0, 2)]?.[code] ?? []).map((e: unknown[]) => e.join('/'));
}

function duties(hs6: string, partner: string, line?: string) {
  const lines = parseHtsLines(exportList(hs6), hs6);
  const target = line ? lines.find((l) => l.htsCode === line)! : lines[0]!;
  const shard = INDEX.coverage[hs6.slice(0, 2)] ?? {};
  const base = resolveBaseRate(target, partner, columnTwoOverride(CATALOG, shard, target.htsCode, partner));
  const list = resolveAdditionalDuties(CATALOG, shard, target.htsCode, partner, base.adValorem);
  return { line: target, base, list, estimate: estimateRate(base.adValorem, list) };
}

const byHeading = (list: UsAdditionalDuty[], heading: string) => list.find((d) => d.heading === heading);
const status = (d: UsAdditionalDuty | undefined) => d?.status.replace('US_ADDITIONAL_DUTY_STATUS_', '');

// ── Chapter 99 parser ──────────────────────────────────────────────────────

describe('chapter 99 notes parser', () => {
  test('list markers advance in their own sequence', () => {
    assert.equal(nextMarker('(b)'), '(c)');
    assert.equal(nextMarker('(z)'), '(aa)');
    assert.equal(nextMarker('(vv)'), '(ww)');
    assert.equal(nextMarker('(ii)'), '(iii)');
    assert.equal(nextMarker('(9)'), '(10)');
  });

  test('a subdivision ends at its next sibling even where the published nesting is wrong', () => {
    const notes = new Chapter99Notes(NOTES_HTML);
    // U.S. note 20(d) is List 2: about 280 provisions. Bounding by depth alone
    // ran it into the rest of note 20 (11,000 provisions).
    const list2 = notes.list({ anchor: 'For the purposes of heading 9903.88.02, products of China', step: 1 });
    assert.equal(list2?.value, '(d)');
    assert.ok(list2!.fullCodes.length > 250 && list2!.fullCodes.length < 320, `List 2: ${list2!.fullCodes.length}`);
  });

  test('enumerated provisions are full coverage; cited ones in an article description are partial', () => {
    const got = classifyCodes(
      'classifiable in the provisions of the HTSUS enumerated in this subdivision: 8471.50 8471.80 '
      + 'Etrogs (classifiable in subheading 0805.90.01); 1. Other printed books, provided for in subheading '
      + '4901.99.00, except for such printed matter provided for in statistical reporting number 4901.99.0040; '
      + 'Articles of steel: 7206 7207 8431.10.0090 8471',
    );
    assert.deepEqual(got.fullCodes, ['8471.50', '8471.80', '7206', '7207', '8431.10.00.90', '8471']);
    assert.deepEqual(got.partialCodes, ['0805.90.01', '4901.99.00', '4901.99.00.40']);
  });

  test('dates and prose numbers are not headings', () => {
    const got = classifyCodes('Proclamation 10925 of April 29, 2025 (90 FR 18899). For example, a TPP threshold of 4800 can be met.');
    assert.deepEqual(got, { fullCodes: [], partialCodes: [] });
  });

  test('heading rates, combined floors and effective windows parse from the heading rows', () => {
    assert.deepEqual(parseAdditionalRate('The duty provided in the applicable subheading + 25%'), { addPct: 25, topUpTo: null });
    assert.deepEqual(parseAdditionalRate('The duty provided in the applicable subheading plus 7.5%'), { addPct: 7.5, topUpTo: null });
    assert.deepEqual(parseAdditionalRate('The duty provided in the applicable subheading'), { addPct: 0, topUpTo: null });
    assert.deepEqual(parseAdditionalRate('10%'), { addPct: null, topUpTo: 10 });
    assert.equal(parseAdditionalRate(''), null);
    assert.deepEqual(
      parseEffectiveWindow('effective with respect to entries on or after January 1, 2025, and before January 1, 2026, articles'),
      { effectiveFrom: '2025-01-01', effectiveThrough: '2025-12-31' },
    );
    assert.deepEqual(
      parseEffectiveWindow('Effective with respect to entries on or after June 15, 2024 and through November 9, 2026, articles'),
      { effectiveFrom: '2024-06-15', effectiveThrough: '2026-11-09' },
    );
  });
});

describe('chapter 99 index built from HTS 2026 Rev 21', () => {
  test('every curated measure resolves', () => {
    const ids = new Set(Object.keys(INDEX.measures));
    for (const spec of [...LIST_DUTIES, ...EXEMPTIONS, ...ENTRY_CONDITIONS]) {
      // 9903.91.04 (facemasks) ended on 2025-12-31 and is the only spec skipped.
      if (spec.heading === '9903.91.04') continue;
      assert.ok(ids.has(spec.id), `${spec.id} missing`);
    }
    assert.equal(Object.keys(INDEX.measures).length, 134);
    assert.ok(INDEX.provisions > 11_000, `provisions: ${INDEX.provisions}`);
  });

  test('IEEPA, Section 122 and expired headings are not measures', () => {
    const headings = new Set(Object.values(INDEX.measures).map((m) => m.heading));
    for (const h of ['9903.01.24', '9903.01.25', '9903.02.20', '9903.03.01', '9903.91.04']) {
      assert.equal(headings.has(h), false, `${h} must not be reported`);
    }
  });

  test('the four-year review moved EVs out of List 3 into note 31', () => {
    assert.deepEqual(entries('8703.80.00'), ['s301-cn-r3/a', 's232-autos/a']);
    assert.deepEqual(entries('8703.23.01'), ['s301-cn-l1/a', 's232-autos/a', 'c2-ru-35/a']);
    assert.deepEqual(entries('8541.42.00'), ['s301-cn-r2/a']);
    assert.deepEqual(entries('4015.12.10'), ['s301-cn-r8/a']);
  });

  test('forced-labor rates are read per country, with paired floors for the deal economies', () => {
    const fl = Object.values(INDEX.measures).filter((m) => m.id.startsWith('s301-fl-'));
    const rate = (partner: string) => fl.filter((m) => m.partners.includes(partner)).map((m) => (m.mfnBand ? `${m.mfnBand.below ? '<' : '>='}${m.mfnBand.pct}:${m.addPct ?? `floor ${m.topUpTo}`}` : m.addPct));
    assert.deepEqual(rate('156'), [12.5]);
    assert.deepEqual(rate('356'), [10]);
    assert.deepEqual(rate('276').sort(), ['<10:floor 10', '>=10:0']);
    assert.deepEqual(rate('392').sort(), ['<12.5:floor 12.5', '>=12.5:0']);
    assert.equal(rate('840').length, 0);
    assert.equal(INDEX.measures['s301-br-9903.05.01'].addPct, 25);
  });

  test('scheduled actions are kept with their start date', () => {
    assert.equal(INDEX.measures['s301-cn-r12'].state, 'SCHEDULED');
    assert.equal(INDEX.measures['s301-cn-r12'].effectiveFrom, '2026-11-10');
  });

  test('the 2025 maritime action is labelled apart from the four-year review', () => {
    for (const id of ['s301-cn-r12', 's301-cn-r14']) {
      assert.equal(INDEX.measures[id].program, 'China maritime and shipbuilding (Section 301)');
    }
    assert.equal(INDEX.measures['s301-cn-r3'].program, 'China four-year review');
  });

  test('a moved anchor fails the whole build instead of publishing a partial index', () => {
    const broken = NOTES_HTML.replace('As provided in heading 9903.05.86', 'As provided in heading 9903.05.8X');
    assert.throws(
      () => buildUsDutyIndex({ notesHtml: broken, headingRows: HEADINGS, release: RELEASE, resolveCountry, now: NOW }),
      (err: Error & { problems?: string[] }) => err.problems?.some((p) => p.startsWith('x-fl-list:')) === true,
    );
  });

  test('an unresolvable country fails the build', () => {
    assert.throws(
      () => buildUsDutyIndex({ notesHtml: NOTES_HTML, headingRows: HEADINGS, release: RELEASE, resolveCountry: (n: string) => (n.includes('Algeria') ? null : resolveCountry(n)), now: NOW }),
      /country not resolved from "Algeria"/,
    );
  });

  test('truncated notes are rejected outright', () => {
    assert.throws(
      () => buildUsDutyIndex({ notesHtml: NOTES_HTML.slice(0, 20_000), headingRows: HEADINGS, release: RELEASE, resolveCountry, now: NOW }),
      /truncated/,
    );
  });

  test('seeder and handler agree on the Redis keys', () => {
    assert.equal(SEED_CATALOG_KEY, US_HTS_CATALOG_KEY);
    assert.equal(SEED_COVERAGE_PREFIX, US_HTS_COVERAGE_PREFIX);
    assert.equal(seedCoverageKey('2026HTSRev21', '87'), usHtsCoverageKey('2026HTSRev21', '87'));
  });
});

// ── Line and rate resolution ───────────────────────────────────────────────

describe('HTS lines and base rates', () => {
  test('exportList ranges cover a subheading or read the line of a statistical number', () => {
    assert.deepEqual(exportListRange('870323'), { from: '8703.23', to: '8703.23.99.99' });
    assert.deepEqual(exportListRange('87032301'), { from: '8703.23.01', to: '8703.23.01.99' });
    assert.deepEqual(exportListRange('8703230140'), { from: '8703.23.01', to: '8703.23.01.99' });
  });

  test('a line whose only statistical row carries the rate is still a line', () => {
    const lines = parseHtsLines(exportList('720810'), '720810');
    assert.deepEqual(lines.map((l) => l.htsCode), ['7208.10.15', '7208.10.30', '7208.10.60']);
    assert.equal(lines[0]!.general, 'Free');
  });

  test('cells come back as plain text with no markup left', () => {
    const [line] = parseHtsLines([{ htsno: '0101.21.00', indent: 1, description: 'Pure<b>bred</b> <scr<script>ipt>x', general: '<i>Free</i>', special: '', other: '' }], '010121');
    assert.equal(line!.description, 'Pure bred iptx');
    assert.equal(/[<>]/.test(line!.description), false);
    assert.equal(line!.general, 'Free');
  });

  test('special-rate groups split per program list', () => {
    assert.deepEqual(parseSpecialRates('Free (A+,AU,BH) 3.6% (KR)'), [
      { rate: 'Free', programs: ['A+', 'AU', 'BH'] },
      { rate: '3.6%', programs: ['KR'] },
    ]);
  });

  test('the partner gets its agreement rate, column 2, or MFN; GSP is ignored as lapsed', () => {
    const [car] = parseHtsLines(exportList('870323'), '870323');
    assert.deepEqual(
      [resolveBaseRate(car!, '484'), resolveBaseRate(car!, '643'), resolveBaseRate(car!, '156'), resolveBaseRate(car!, '356')].map((b) => [b.basis, b.text, b.program]),
      [
        ['US_DUTY_BASIS_PREFERENTIAL', 'Free', 'S'],
        ['US_DUTY_BASIS_COLUMN_2', '10%', ''],
        ['US_DUTY_BASIS_MFN', '2.5%', ''],
        // India is a GSP country, but GSP ("A+") has lapsed since 2021.
        ['US_DUTY_BASIS_MFN', '2.5%', ''],
      ],
    );
    assert.deepEqual(resolveBaseRate(car!, '156').unresolved, ['D', 'E']);
  });

  test('a statistical number listed under a line is partial coverage of the line', () => {
    const hits = coverageFor({ '9401': [['x', 'x']], '9401.61.40.11': [['s232-furniture', 'a']], '9401.69': [['y', 'a']] }, '9401.61.40');
    assert.deepEqual(hits, [{ id: 'x', role: 'x', partial: false }, { id: 's232-furniture', role: 'a', partial: true }]);
  });
});

describe('chapter 99 duties on real lines', () => {
  test('Chinese EVs: 2.5% MFN + 100% four-year review; Section 232 flagged, forced labor turns on it', () => {
    const { list, estimate } = duties('870380', '156');
    assert.equal(status(byHeading(list, '9903.91.03')), 'APPLIES');
    assert.equal(byHeading(list, '9903.91.03')!.addedRate, 100);
    assert.equal(status(byHeading(list, '9903.94.01')), 'CONDITIONAL');
    assert.equal(status(byHeading(list, '9903.05.31')), 'CONDITIONAL');
    assert.match(byHeading(list, '9903.05.31')!.condition, /Section 232/);
    assert.equal(byHeading(list, '9903.88.03'), undefined, 'not on List 3');
    assert.deepEqual(estimate, { rate: 102.5, complete: false });
  });

  test('Chinese cars keep List 1 with its narrow exclusion named', () => {
    const { list, estimate } = duties('870323', '156');
    const l1 = byHeading(list, '9903.88.01')!;
    assert.equal(status(l1), 'APPLIES');
    assert.match(l1.condition, /9903\.88\.69/);
    assert.equal(estimate.rate, 27.5);
  });

  test('Chinese integrated circuits: forced labor exempt by product list, four-year review applies', () => {
    const { list, estimate } = duties('854231', '156');
    assert.equal(status(byHeading(list, '9903.05.31')), 'EXEMPT');
    assert.equal(status(byHeading(list, '9903.91.05')), 'APPLIES');
    assert.deepEqual(estimate, { rate: 50, complete: true });
  });

  test('Indian cotton T-shirts: 16.5% MFN + 10% forced labor, complete', () => {
    const { list, estimate } = duties('610910', '356');
    assert.deepEqual(list.map((d) => [d.heading, status(d)]), [['9903.05.44', 'APPLIES']]);
    assert.deepEqual(estimate, { rate: 26.5, complete: true });
  });

  test('Mexican cars enter Free under USMCA; forced labor depends on the USMCA entry', () => {
    const { base, list } = duties('870323', '484');
    assert.equal(base.program, 'S');
    assert.equal(status(byHeading(list, '9903.05.55')), 'CONDITIONAL');
    assert.match(byHeading(list, '9903.05.55')!.condition, /USMCA/);
  });

  test('Brazilian oranges stack the Brazil and forced-labor actions', () => {
    const { list, estimate } = duties('080590', '076');
    assert.deepEqual(list.map((d) => [d.heading, status(d)]), [['9903.05.01', 'APPLIES'], ['9903.05.27', 'APPLIES']]);
    assert.deepEqual(estimate, { rate: 38.3, complete: true });
  });

  test('French wine: a specific duty leaves the EU floor to the ad valorem equivalent', () => {
    const { base, list, estimate } = duties('220421', '250');
    assert.equal(base.adValorem, null);
    assert.deepEqual(list.map((d) => [d.heading, status(d), d.topUpTo]), [['9903.05.39', 'CONDITIONAL', 10]]);
    assert.equal(estimate.complete, false);
  });

  test('Russian goods on the note 30 lists take the flat rate in lieu of column 2', () => {
    const car = duties('870323', '643');
    assert.deepEqual([car.base.basis, car.base.text, car.base.adValorem], ['US_DUTY_BASIS_COLUMN_2', '35% (9903.90.08)', 35]);
    const steel = duties('720810', '643', '7208.10.30');
    assert.deepEqual([steel.base.text, steel.base.adValorem], ['70% (9903.90.09)', 70]);
    // Belarus is column 2 as well, but note 30 names only Russia.
    assert.equal(duties('870323', '112').base.text, '10%');
  });

  test('a product exemption lifts a floor duty even when the base is a specific duty', () => {
    const catalog: UsDutyCatalog = {
      schema: 1,
      release: 'r',
      chapters: ['22'],
      measures: {
        'fl-lt': { id: 'fl-lt', kind: 'duty', heading: '9903.05.39', authority: 'SECTION_301', partners: ['250'], scope: 'ALL_PRODUCTS', addPct: null, topUpTo: 10, mfnBand: { below: true, pct: 10 }, note: 'U.S. note 52(a)', condition: '' },
        'fl-ge': { id: 'fl-ge', kind: 'duty', heading: '9903.05.38', authority: 'SECTION_301', partners: ['250'], scope: 'ALL_PRODUCTS', addPct: 0, topUpTo: null, mfnBand: { below: false, pct: 10 }, note: 'U.S. note 52(a)', condition: '' },
        x: { id: 'x', kind: 'exemption', heading: '9903.05.86', appliesTo: 'fl-', partners: null, note: 'U.S. note 52(b)', condition: '' },
      },
    };
    const list = resolveAdditionalDuties(catalog, { '2204.21.50': [['x', 'x']] }, '2204.21.50', '250', null);
    assert.deepEqual(list.map((d) => [d.heading, status(d)]), [['9903.05.39', 'EXEMPT']]);
    const unlisted = resolveAdditionalDuties(catalog, {}, '2204.21.50', '250', null);
    assert.deepEqual(unlisted.map((d) => [d.heading, status(d)]), [['9903.05.39', 'CONDITIONAL']]);
  });

  test('effective dates are re-checked at request time, not taken from the seed', () => {
    const duty = { kind: 'duty', heading: '9903.91.99', authority: 'SECTION_301', partners: ['156'], scope: 'ALL_PRODUCTS', addPct: 25, topUpTo: null, note: 'U.S. note 31', condition: '' };
    const catalog = {
      schema: 1,
      release: 'r',
      chapters: ['85'],
      measures: {
        starts: { ...duty, id: 'starts', heading: '9903.91.98', effectiveFrom: '2026-11-10', state: 'SCHEDULED' },
        ends: { ...duty, id: 'ends', effectiveThrough: '2026-11-09', state: 'IN_FORCE' },
      },
    } as unknown as UsDutyCatalog;
    const at = (day: string) => resolveAdditionalDuties(catalog, {}, '8542.31.00', '156', 0, day).map((d) => [d.heading, status(d)]);
    assert.deepEqual(at('2026-11-09'), [['9903.91.98', 'SCHEDULED'], ['9903.91.99', 'APPLIES']]);
    assert.deepEqual(at('2026-11-10'), [['9903.91.98', 'APPLIES']]);
  });

  test('an exemption counts only inside its effective window', () => {
    const catalog = {
      schema: 1,
      release: 'r',
      chapters: ['85'],
      measures: {
        fl: { id: 'fl', kind: 'duty', heading: '9903.05.31', authority: 'SECTION_301', partners: ['156'], scope: 'ALL_PRODUCTS', addPct: 12.5, topUpTo: null, note: 'U.S. note 52(a)', condition: '' },
        ended: { id: 'ended', kind: 'exemption', heading: '9903.05.86', appliesTo: 'fl', partners: null, effectiveThrough: '2026-11-09', note: 'U.S. note 52(b)', condition: '' },
        later: { id: 'later', kind: 'exemption', heading: '9903.05.87', appliesTo: 'fl', partners: null, effectiveFrom: '2026-11-20', note: 'U.S. note 52(c)', condition: '' },
      },
    } as unknown as UsDutyCatalog;
    const shard = { '8542.31.00': [['ended', 'x'], ['later', 'x']] };
    const at = (day: string) => resolveAdditionalDuties(catalog, shard, '8542.31.00', '156', 0, day).map((d) => [d.heading, status(d), d.condition]);
    assert.deepEqual(at('2026-11-09'), [['9903.05.31', 'EXEMPT', 'Exempt under 9903.05.86 (U.S. note 52(b)).']]);
    assert.deepEqual(at('2026-11-10'), [['9903.05.31', 'APPLIES', '']]);
    assert.deepEqual(at('2026-11-20'), [['9903.05.31', 'EXEMPT', 'Exempt under 9903.05.87 (U.S. note 52(c)).']]);
  });

  test('a top-up raises the base to the floor instead of adding to it', () => {
    const topUp = { status: 'US_ADDITIONAL_DUTY_STATUS_APPLIES', addedRate: 0, topUpTo: 15 } as UsAdditionalDuty;
    assert.deepEqual(estimateRate(2.5, [topUp]), { rate: 15, complete: true });
    assert.deepEqual(estimateRate(20, [topUp]), { rate: 20, complete: true });
  });
});

// ── Handler ────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  localApiMode: process.env.LOCAL_API_MODE,
  validKeys: process.env.WORLDMONITOR_VALID_KEYS,
};
const REDIS_HOST = 'https://redis.test';
const HTS_ORIGIN = 'https://hts.usitc.gov';
const ENTERPRISE_KEY = 'test-us-import-duty-enterprise-key';

let redisStore: Map<string, string>;
let redisSets: string[];
let htsCalls: string[];
let htsFault: boolean;

function seedIndex() {
  for (const [ch, shard] of Object.entries(INDEX.coverage)) redisStore.set(usHtsCoverageKey(INDEX.release, ch), JSON.stringify(shard));
  redisStore.set(US_HTS_CATALOG_KEY, JSON.stringify(CATALOG));
}

beforeEach(() => {
  redisStore = new Map();
  redisSets = [];
  htsCalls = [];
  htsFault = false;
  process.env.UPSTASH_REDIS_REST_URL = REDIS_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  delete process.env.LOCAL_API_MODE;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    if (url.origin === REDIS_HOST && url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      return new Response(JSON.stringify({ result: redisStore.get(key) ?? null }), { status: 200 });
    }
    if (url.origin === REDIS_HOST) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const commands: unknown[][] = Array.isArray(body?.[0]) ? body : [body];
      for (const cmd of commands) {
        if (Array.isArray(cmd) && cmd[0] === 'SET') {
          redisStore.set(String(cmd[1]), String(cmd[2]));
          redisSets.push(String(cmd[1]));
        }
      }
      const reply = Array.isArray(body?.[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' };
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    if (url.origin === HTS_ORIGIN && url.pathname === '/reststop/exportList') {
      htsCalls.push(href);
      if (htsFault) return new Response('Service Unavailable', { status: 503 });
      const hs6 = (url.searchParams.get('from') ?? '').replace(/\./g, '').slice(0, 6);
      try {
        return new Response(JSON.stringify(exportList(hs6)), { status: 200 });
      } catch {
        return new Response('[]', { status: 200 });
      }
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
    ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
    ['LOCAL_API_MODE', ORIGINAL_ENV.localApiMode],
    ['WORLDMONITOR_VALID_KEYS', ORIGINAL_ENV.validKeys],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function premiumCtx(): ServerContext {
  return {
    request: new Request(`https://api.worldmonitor.app${ROUTE}`, { headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY } }),
  } as ServerContext;
}

describe('GetUsImportDuty handler', () => {
  test('serves lines with duties from the seeded index and caches the HTS read', async () => {
    seedIndex();
    const res = await getUsImportDuty(premiumCtx(), { hsCode: '870380', partnerCountry: '156' });
    assert.equal(res.unavailableReason, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UNSPECIFIED');
    assert.equal(res.htsRelease, '2026HTSRev21');
    assert.equal(res.additionalDutiesLoaded, true);
    assert.equal(res.lines.length, 1);
    assert.equal(res.lines[0]!.estimatedRate, 102.5);
    assert.equal(res.sourceUrl, 'https://hts.usitc.gov/search?query=8703.80');
    assert.deepEqual(htsCalls, ['https://hts.usitc.gov/reststop/exportList?from=8703.80&to=8703.80.99.99&format=JSON&styles=false']);
    assert.ok(redisStore.has('trade:us-hts:lines:v1:2026HTSRev21:870380'), 'lines are cached under the index release');
    await getUsImportDuty(premiumCtx(), { hsCode: '870380', partnerCountry: '392' });
    assert.equal(htsCalls.length, 1, 'every partner shares one cached HTS read');
  });

  test('a new release reads fresh lines instead of the previous release\'s cache', async () => {
    seedIndex();
    await getUsImportDuty(premiumCtx(), { hsCode: '870380', partnerCountry: '156' });
    const next = { ...CATALOG, release: '2026HTSRev22' };
    for (const [ch, shard] of Object.entries(INDEX.coverage)) redisStore.set(usHtsCoverageKey(next.release, ch), JSON.stringify(shard));
    redisStore.set(US_HTS_CATALOG_KEY, JSON.stringify(next));
    const res = await getUsImportDuty(premiumCtx(), { hsCode: '870380', partnerCountry: '156' });
    assert.equal(res.htsRelease, '2026HTSRev22');
    assert.equal(htsCalls.length, 2);
  });

  test('a missing index still serves the base rates, flagged', async () => {
    const res = await getUsImportDuty(premiumCtx(), { hsCode: '610910', partnerCountry: '356' });
    assert.equal(res.additionalDutiesLoaded, false);
    assert.equal(res.lines[0]!.baseRate, '16.5%');
    assert.deepEqual(res.lines[0]!.additionalDuties, []);
    assert.equal(res.lines[0]!.estimateComplete, false);
  });

  test('a code with no HTS line is a coverage answer', async () => {
    seedIndex();
    const res = await getUsImportDuty(premiumCtx(), { hsCode: '999999', partnerCountry: '156' });
    assert.equal(res.unavailableReason, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_NOT_COVERED');
    assert.equal(res.upstreamUnavailable, false);
  });

  test('an HTS fault is reported as a fault', async () => {
    htsFault = true;
    const res = await getUsImportDuty(premiumCtx(), { hsCode: '870323', partnerCountry: '156' });
    assert.equal(res.unavailableReason, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE');
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.lines, []);
  });

  test('a free caller gets the entitlement shape and reaches no upstream', async () => {
    const res = await getUsImportDuty({ request: new Request(`https://api.worldmonitor.app${ROUTE}`) } as ServerContext, { hsCode: '870323', partnerCountry: '156' });
    assert.equal(res.upstreamUnavailable, true);
    assert.equal(res.unavailableReason, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UNSPECIFIED');
    assert.equal(htsCalls.length, 0);
  });

  test('a malformed request reaching the handler directly is rejected without a fetch', async () => {
    for (const req of [{ hsCode: '8703', partnerCountry: '156' }, { hsCode: '870323', partnerCountry: 'CN' }]) {
      const res = await getUsImportDuty(premiumCtx(), req);
      assert.equal(res.unavailableReason, 'US_IMPORT_DUTY_UNAVAILABLE_REASON_INVALID_REQUEST');
    }
    assert.equal(htsCalls.length, 0);
  });
});

describe('GetUsImportDuty contract', () => {
  test('the gateway rejects malformed codes before the handler runs', () => {
    for (const hsCode of ['870323', '87032301', '8703230140']) {
      assert.equal(validateGeneratedRequest('getUsImportDuty', { hsCode, partnerCountry: '156' }), undefined, hsCode);
    }
    for (const body of [
      { hsCode: '8703', partnerCountry: '156' },
      { hsCode: '8703231', partnerCountry: '156' },
      { hsCode: '', partnerCountry: '156' },
      { hsCode: '870323', partnerCountry: 'CN' },
      { hsCode: '870323', partnerCountry: '' },
    ]) {
      assert.ok(validateGeneratedRequest('getUsImportDuty', body), `expected a violation for ${JSON.stringify(body)}`);
    }
  });

  test('the route is Pro-gated at tier 1, which every paid plan including API Starter meets', () => {
    assert.ok(PREMIUM_RPC_PATHS.has(ROUTE));
    assert.equal(getRequiredTier(ROUTE), 1);
  });
});

describe('US HTS seeder branch', () => {
  test('reads the release USITC marks current', async () => {
    const { currentHtsRelease } = await import('../scripts/seed-supply-chain-trade.mjs');
    const releases = JSON.parse(readFileSync(resolve(FIXTURES, 'release-list-excerpt.json'), 'utf8'));
    assert.deepEqual(currentHtsRelease(releases), { name: '2026HTSRev21', startDate: '10/09/2026' });
    assert.throws(() => currentHtsRelease([{ name: 'x', status: 'archive' }]), /no current release/);
  });

  test('publishes every shard before the catalog that names their release', async () => {
    const { publishUsHtsIndex, US_HTS_TTL } = await import('../scripts/seed-supply-chain-trade.mjs');
    await publishUsHtsIndex(INDEX);
    const catalogAt = redisSets.indexOf(US_HTS_CATALOG_KEY);
    const shardKeys = Object.keys(INDEX.coverage).map((ch) => usHtsCoverageKey(INDEX.release, ch));
    assert.ok(catalogAt > 0, 'catalog written');
    for (const key of shardKeys) assert.ok(redisSets.indexOf(key) >= 0 && redisSets.indexOf(key) < catalogAt, key);
    assert.ok(redisSets.includes('seed-meta:trade:us-hts:catalog'), 'seed-meta written');
    assert.ok(redisSets.indexOf('seed-activated:trade:us-hts') > catalogAt, 'activation marker set after the catalog');
    assert.equal(US_HTS_TTL, 86400);
    const catalog = JSON.parse(redisStore.get(US_HTS_CATALOG_KEY)!);
    assert.equal(catalog.release, '2026HTSRev21');
    assert.deepEqual(catalog.chapters, Object.keys(INDEX.coverage).sort());
  });
});
