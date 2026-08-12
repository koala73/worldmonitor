// Pin the education-attainment seeder's record parsing and validate floor.
//
// Series: SE.SEC.CUAT.UP.FE.ZS — educational attainment, at least completed
// upper secondary, population 25+, female (%). Feeds the `education`
// dimension of the Country Resilience Index.
//
// The pure reducer `reduceAttainmentRecords` is exported so these run fully
// offline — no network, no recorded fixture. The seeder's network path uses
// the same paged World Bank pattern as `seed-wb-external-debt.mjs`.
//
// The null-coercion case below is the one that matters most: this series can
// legitimately read near zero (Niger is 1.15%), so a `value: null` coerced to
// 0 would publish a plausible-looking wrong number rather than an obvious one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import sovereignStatus from '../scripts/shared/sovereign-status.json' with { type: 'json' };

import {
  reduceAttainmentRecords,
  validate,
  declareRecords,
  MIN_COUNTRIES,
  ATTAINMENT_INDICATOR,
  OBSERVATION_WINDOW_YEARS,
  WB_PAGE_SIZE,
  EDUCATION_MAX_EXPECTED_PAGES,
  EDUCATION_PAGE_WORST_CASE_MS,
  EDUCATION_OUTER_ATTEMPTS,
  EDUCATION_RETRY_BACKOFF_MS,
  EDUCATION_FETCH_PROCESSING_HEADROOM_MS,
  EDUCATION_FETCH_PHASE_TIMEOUT_MS,
  EDUCATION_LOCK_TTL_MS,
  EDUCATION_SECTION_TIMEOUT_MS,
  observationWindowStart,
  buildCoverageDropReport,
  diffCountrySets,
  parseCountrySetMeta,
  MAX_EXPECTED_COUNTRY_DROP,
  COUNTRY_SET_META_FIELD,
  SEED_META_KEY,
  ACTIVATION_MIN_COUNTRIES,
  COUNTRY_SET_BASELINE_KEY,
  rankableCountryCodes,
  readPreviousCountrySet,
  writeCountrySetBaseline,
  afterPublish,
} from '../scripts/seed-education-attainment.mjs';

const row = (iso3, date, value) => ({ countryiso3code: iso3, date: String(date), value });

describe('reduceAttainmentRecords — parsing', () => {
  it('maps ISO3 to ISO2 and keeps the value', () => {
    const out = reduceAttainmentRecords([row('FRA', 2023, 82.5)]);
    assert.deepEqual(out.FR, { value: 82.5, year: 2023 });
  });

  it('keeps the most recent year when a country reports several', () => {
    const out = reduceAttainmentRecords([
      row('KEN', 2019, 30.1),
      row('KEN', 2023, 34.7),
      row('KEN', 2021, 32.0),
    ]);
    assert.equal(out.KE.year, 2023);
    assert.equal(out.KE.value, 34.7);
  });

  it('skips a null value instead of coercing it to 0 and overwriting a real reading', () => {
    // Number(null) === 0 and is finite. Without an explicit null-skip, the
    // later null row would beat the earlier real one on year comparison and
    // publish Niger-like 0% attainment for a country that reports ~34%.
    const out = reduceAttainmentRecords([
      row('KEN', 2021, 34.7),
      row('KEN', 2023, null),
    ]);
    assert.equal(out.KE.value, 34.7, 'null row must not overwrite the real observation');
    assert.equal(out.KE.year, 2021);
  });

  it('drops a country whose only row is null rather than publishing 0', () => {
    const out = reduceAttainmentRecords([row('SSD', 2023, null)]);
    assert.equal(out.SS, undefined);
  });

  it('rejects out-of-range percentages as upstream corruption', () => {
    const out = reduceAttainmentRecords([
      row('BRA', 2023, 145),
      row('CHL', 2023, -3),
    ]);
    assert.equal(out.BR, undefined);
    assert.equal(out.CL, undefined);
  });

  it('accepts the observed distribution extremes', () => {
    // Niger 1.15 is the measured minimum, Belarus 98.18 the measured maximum.
    // Both must survive parsing or the goalposts lose their anchors.
    const out = reduceAttainmentRecords([row('NER', 2022, 1.15), row('BLR', 2023, 98.18)]);
    assert.equal(out.NE.value, 1.15);
    assert.equal(out.BY.value, 98.18);
  });

  it('ignores rows whose code resolves to no ISO2 (World Bank aggregates)', () => {
    // "WLD", "EUU", "OED" and friends are aggregates, not countries.
    const out = reduceAttainmentRecords([row('ZZZ', 2023, 50), row('FRA', 2023, 82.5)]);
    assert.deepEqual(Object.keys(out), ['FR']);
  });

  it('skips a non-numeric year', () => {
    const out = reduceAttainmentRecords([{ countryiso3code: 'FRA', date: 'n/a', value: 82.5 }]);
    assert.equal(out.FR, undefined);
  });

  it('folds successive pages into one accumulator', () => {
    const out = {};
    reduceAttainmentRecords([row('FRA', 2021, 80.0)], out);
    reduceAttainmentRecords([row('FRA', 2024, 83.2), row('DEU', 2023, 86.1)], out);
    assert.equal(out.FR.year, 2024);
    assert.equal(out.DE.value, 86.1);
  });
});

describe('validate — floor', () => {
  const many = (n) => {
    const countries = {};
    for (let i = 0; i < n; i++) countries[`X${i}`] = { value: 50, year: 2023 };
    return { countries };
  };

  it('accepts a payload at the floor', () => {
    assert.equal(validate(many(MIN_COUNTRIES)), true);
  });

  it('rejects a truncated payload one below the floor', () => {
    // A partial World Bank response must not refresh seed-meta, or the bundle
    // freezes on a truncated snapshot.
    assert.equal(validate(many(MIN_COUNTRIES - 1)), false);
  });

  it('rejects an empty or malformed payload', () => {
    assert.equal(validate({ countries: {} }), false);
    assert.equal(validate({}), false);
    assert.equal(validate(null), false);
  });

  it('the floor sits below the measured coverage with headroom', () => {
    // Measured 2026-08-10: 181 of the 196 rankable countries. The floor is
    // deliberately lower so a transient upstream dip does not poison
    // seed-meta, but high enough that a real outage still fails closed.
    assert.ok(MIN_COUNTRIES < 181, 'floor must not exceed measured coverage');
    assert.ok(MIN_COUNTRIES >= 100, 'floor must still catch a substantially truncated fetch');
  });
});

describe('declareRecords', () => {
  it('counts published countries', () => {
    assert.equal(declareRecords({ countries: { FR: {}, DE: {} } }), 2);
    assert.equal(declareRecords({}), 0);
    assert.equal(declareRecords(null), 0);
  });
});

describe('series identity', () => {
  it('pins the female variant, not the total or male series', () => {
    // The construct rests on the female series specifically — the causal
    // literature's income-independent effect is measured on it. Swapping to
    // .ZS (total) or .MA.ZS (male) would silently change what is scored.
    assert.equal(ATTAINMENT_INDICATOR, 'SE.SEC.CUAT.UP.FE.ZS');
  });
});

describe('rolling observation window', () => {
  it('preserves the measured 2011 lower bound in 2026', () => {
    assert.equal(OBSERVATION_WINDOW_YEARS, 15);
    assert.equal(observationWindowStart(2026), 2011);
  });

  it('advances the lower bound when the calendar year advances', () => {
    assert.equal(observationWindowStart(2027), 2012);
  });
});

describe('fetch and Railway bundle budgets', () => {
  it('fits all outer retries, backoff, and processing inside the explicit deadline', () => {
    assert.equal(WB_PAGE_SIZE, 5_000);
    assert.ok(
      EDUCATION_OUTER_ATTEMPTS * EDUCATION_MAX_EXPECTED_PAGES * EDUCATION_PAGE_WORST_CASE_MS
        + EDUCATION_RETRY_BACKOFF_MS
        + EDUCATION_FETCH_PROCESSING_HEADROOM_MS
        <= EDUCATION_FETCH_PHASE_TIMEOUT_MS,
    );
  });

  it('preserves fetch, publish, section, and Railway cleanup headroom', () => {
    assert.ok(EDUCATION_FETCH_PHASE_TIMEOUT_MS < EDUCATION_LOCK_TTL_MS);
    assert.ok(EDUCATION_LOCK_TTL_MS < EDUCATION_SECTION_TIMEOUT_MS);
    assert.ok(EDUCATION_SECTION_TIMEOUT_MS + 10_000 <= 570_000);

    const bundleSource = readFileSync(
      new URL('../scripts/seed-bundle-macro.mjs', import.meta.url),
      'utf8',
    );
    assert.match(bundleSource, /maxBundleMs:\s*570_000/);
    assert.match(
      bundleSource,
      /Education-Attainment[^\n]+timeoutMs:\s*EDUCATION_SECTION_TIMEOUT_MS/,
    );
    assert.match(bundleSource, /EDUCATION_PRIORITY_UTC_DAY\s*=\s*0/);
    assert.match(
      bundleSource,
      /educationRunsFirst[\s\S]+\? \[EDUCATION_SECTION, \.\.\.MACRO_SECTIONS\][\s\S]+: \[\.\.\.MACRO_SECTIONS, EDUCATION_SECTION\]/,
    );
    assert.match(
      bundleSource,
      /normally last[\s\S]+first priority on one UTC day each week[\s\S]+production keeps the other[\s\S]+six days/,
    );
  });
});

// ---------------------------------------------------------------------------
// Coverage-drop set-diff warning (#6460).
//
// The 150 validation floor does not catch a partial fetch: 161 countries clears
// it while silently moving ~20 onto the 50/0.3 `unmonitored` imputation. These
// pin the decision half, which is pure and so runs with no Redis.
// ---------------------------------------------------------------------------

describe('coverage-drop set-diff', () => {
  it('records a baseline and warns about nothing on the first run', () => {
    // A missing previous set is not evidence of a drop. Redis read errors are
    // handled separately by afterPublish so they cannot replace the baseline.
    const report = buildCoverageDropReport(null, ['FR', 'DE', 'US'], 0);
    assert.equal(report.baseline, true);
    assert.equal(report.warn, false);
    assert.deepEqual(report.dropped, []);
    assert.equal(report.countryCount, 3);
    assert.equal(report.countrySet, 'DE,FR,US', 'persisted sorted so the diff is order-independent');
  });

  it('does not warn when the set is unchanged', () => {
    // The expected week-over-week delta for an annually-republished series is
    // exactly zero, so this is the overwhelmingly common case.
    const codes = ['FR', 'DE', 'US'];
    const report = buildCoverageDropReport(codes, [...codes].reverse(), 0);
    assert.equal(report.warn, false);
    assert.deepEqual(report.dropped, []);
    assert.deepEqual(report.added, []);
  });

  it('warns only from the (threshold + 1)th disappearance', () => {
    const prev = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF'];
    const atLimit = buildCoverageDropReport(prev, prev.slice(MAX_EXPECTED_COUNTRY_DROP), 0);
    assert.equal(atLimit.dropped.length, MAX_EXPECTED_COUNTRY_DROP);
    assert.equal(atLimit.warn, false, 'a drop exactly at the threshold must not warn');

    const overLimit = buildCoverageDropReport(prev, prev.slice(MAX_EXPECTED_COUNTRY_DROP + 1), 0);
    assert.equal(overLimit.dropped.length, MAX_EXPECTED_COUNTRY_DROP + 1);
    assert.equal(overLimit.warn, true);
  });

  it('catches a same-count swap that any count check misses', () => {
    // The reason the stored value is a SET and not a count: 181 -> 181 with
    // three countries swapped is invisible to recordCount alone, yet moves
    // three real countries onto the unmonitored imputation.
    const prev = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF'];
    const curr = ['AA', 'BB', 'CC', 'XX', 'YY', 'ZZ'];
    const report = buildCoverageDropReport(prev, curr, 0);
    assert.equal(report.countryCount, prev.length, 'count is identical');
    assert.equal(report.warn, true, 'but the set-diff still fires');
    assert.deepEqual(report.dropped, ['DD', 'EE', 'FF']);
    assert.deepEqual(report.added, ['XX', 'YY', 'ZZ']);
  });

  it('does not warn on additions alone', () => {
    // A World Bank republication that ADDS reporters is good news; only
    // disappearances move countries onto the imputation.
    const report = buildCoverageDropReport(['AA'], ['AA', 'BB', 'CC', 'DD', 'EE'], 0);
    assert.equal(report.warn, false);
    assert.deepEqual(report.added, ['BB', 'CC', 'DD', 'EE']);
  });

  it('fires on the exact partial-fetch shape the 150 floor lets through', () => {
    // The scenario the runbook names: a fetch returning 161 clears validate()
    // while dropping 20 countries onto the imputation.
    const prev = Array.from({ length: 181 }, (_, i) => `C${i}`);
    const curr = prev.slice(0, 161);
    const report = buildCoverageDropReport(prev, curr, 0);
    assert.equal(report.warn, true);
    assert.equal(report.dropped.length, 20);
    assert.equal(
      validate({ countries: Object.fromEntries(curr.map((c) => [c, {}])) }),
      true,
      'validate() still passes on 161 — which is exactly why this warning has to exist',
    );
  });
});

describe('country-set seed-meta round trip', () => {
  it('parses a persisted set back to codes', () => {
    const report = buildCoverageDropReport(null, ['FR', 'DE'], 0);
    assert.deepEqual(parseCountrySetMeta(report.countrySet), ['DE', 'FR']);
  });

  it('treats a missing, empty, or malformed field as no previous set', () => {
    // Must degrade to "baseline", never to "everything disappeared".
    for (const raw of [undefined, null, '', 42, {}, ',,,']) {
      assert.equal(parseCountrySetMeta(raw), null, `raw=${JSON.stringify(raw)}`);
    }
  });

  it('names the field the seeder actually persists', () => {
    assert.equal(COUNTRY_SET_META_FIELD, 'countrySet');
  });

  it('keeps SEED_META_KEY in step with the key runSeed actually derives', () => {
    // runSeed writes `seed-meta:${domain}:${resource}`, but the previous-set
    // read hardcodes the key so it can run before that write. Two spellings of
    // one key drift silently: the read would return null forever, every run
    // would look like a first run, and the coverage-drop warning would never
    // fire again while still logging "baseline recorded" as if healthy.
    const source = readFileSync(new URL('../scripts/seed-education-attainment.mjs', import.meta.url), 'utf8');
    const call = source.match(/runSeed\(\s*'([^']+)'\s*,\s*'([^']+)'/);
    assert.ok(call, 'could not find the runSeed(domain, resource, ...) call');
    assert.equal(SEED_META_KEY, `seed-meta:${call[1]}:${call[2]}`);
  });

  it('diffCountrySets reports both directions independently', () => {
    const { dropped, added } = diffCountrySets(['A1', 'B1'], ['B1', 'C1']);
    assert.deepEqual(dropped, ['A1']);
    assert.deepEqual(added, ['C1']);
  });
});

describe('rankable coverage and durable comparison baseline', () => {
  const rankable = sovereignStatus.entries.map((entry) => entry.iso2);

  it('warns when rankable coverage falls below the binding 180-country activation floor', () => {
    assert.ok(rankable.length >= ACTIVATION_MIN_COUNTRIES);
    const current = rankable.slice(0, ACTIVATION_MIN_COUNTRIES - 1);
    const report = buildCoverageDropReport(rankable.slice(0, ACTIVATION_MIN_COUNTRIES + 1), current);

    assert.equal(report.countryCount, ACTIVATION_MIN_COUNTRIES - 1);
    assert.equal(report.belowActivationFloor, true);
    assert.equal(report.warn, true);
  });

  it('filters non-rankable territories before evaluating the activation floor', () => {
    const current = [...rankable.slice(0, ACTIVATION_MIN_COUNTRIES - 1), 'AS', 'GU', 'PR'];
    assert.equal(current.length, ACTIVATION_MIN_COUNTRIES + 2);
    assert.equal(rankableCountryCodes(current).length, ACTIVATION_MIN_COUNTRIES - 1);
  });

  it('does not replace the last confirmed baseline when Redis read fails', async () => {
    let writes = 0;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const result = await afterPublish(
        { countries: Object.fromEntries(rankable.slice(0, 179).map((cc) => [cc, {}])) },
        {
          readCountrySetBaseline: async () => ({ status: 'error', reason: 'redis timeout' }),
          writeCountrySetBaseline: async () => { writes++; return { status: 'ok' }; },
        },
      );
      assert.equal(writes, 0, 'an unreadable baseline must never be replaced');
      assert.equal(result.freshnessMetaPatch.coverageComparisonUnavailable, 'redis timeout');
      assert.equal(result.freshnessMetaPatch.rankableCoverageBelowFloor, '179/180');
      assert.equal(result.freshnessMetaPatch.rankableRecordCount, 179);
      assert.ok(warnings.some((line) => line.includes('last confirmed baseline was not replaced')));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('writes the current rankable set only after a successful read-and-compare', async () => {
    const current = rankable.slice(0, ACTIVATION_MIN_COUNTRIES - 1);
    let written = null;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await afterPublish(
        { countries: Object.fromEntries([...current, 'AS'].map((cc) => [cc, {}])) },
        {
          readCountrySetBaseline: async () => ({
            status: 'ok',
            codes: rankable.slice(0, ACTIVATION_MIN_COUNTRIES + 1),
          }),
          writeCountrySetBaseline: async (countrySet) => {
            written = countrySet;
            return { status: 'ok' };
          },
        },
      );
      assert.equal(written, [...current].sort().join(','));
      assert.equal(result.freshnessMetaPatch.rankableCoverageBelowFloor, '179/180');
      assert.equal(result.freshnessMetaPatch.rankableRecordCount, 179);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('uses the dedicated baseline key for reads and writes', async () => {
    const commands = [];
    const command = async (_url, _token, args) => {
      commands.push(args);
      return args[0] === 'GET' ? { result: 'DE,FR' } : { result: 'OK' };
    };
    const credentials = { url: 'https://redis.invalid', token: 'test-token' };

    assert.deepEqual(
      await readPreviousCountrySet({ credentials, command }),
      { status: 'ok', codes: ['DE', 'FR'] },
    );
    assert.deepEqual(
      await writeCountrySetBaseline('DE,FR', { credentials, command }),
      { status: 'ok' },
    );
    assert.deepEqual(commands[0], ['GET', COUNTRY_SET_BASELINE_KEY]);
    assert.deepEqual(commands[1].slice(0, 3), ['SET', COUNTRY_SET_BASELINE_KEY, 'DE,FR']);
  });
});
