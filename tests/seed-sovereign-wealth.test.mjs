import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCoverageSummary,
  declareRecords,
  detectCurrency,
  lookupUsdRate,
  matchWikipediaRecord,
  parseWikipediaArticleInfobox,
  parseWikipediaRankingsTable,
  pickLatestPerCountry,
  validate,
} from '../scripts/seed-sovereign-wealth.mjs';
import { SHARED_FX_FALLBACKS } from '../scripts/_seed-utils.mjs';

// Fixture HTML mirrors the structure observed on the shipping
// Wikipedia "List of sovereign wealth funds" article (captured
// 2026-04-23). Kept inline so the scraper's parsing rules are
// exercised without a live network round-trip. If Wikipedia later
// changes the column order or header text, update this fixture AND
// the assumed-columns comment in scripts/seed-sovereign-wealth.mjs
// in the same commit.

const FIXTURE_HTML = `
<html><body>
<table class="wikitable sortable static-row-numbers">
  <thead>
    <tr>
      <th scope="col">Country or region</th>
      <th scope="col">Abbrev.</th>
      <th scope="col">Fund name</th>
      <th scope="col">Assets</th>
      <th scope="col">Inception</th>
      <th scope="col">Origin</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="/wiki/Norway">Norway</a></td>
      <td>GPF-G</td>
      <td><a href="/wiki/GPFG">Government Pension Fund Global</a></td>
      <td>2,117<sup>37</sup></td>
      <td>1990</td>
      <td>Oil & Gas</td>
    </tr>
    <tr>
      <td><a href="/wiki/UAE">United Arab Emirates</a></td>
      <td>ADIA</td>
      <td><a href="/wiki/ADIA">Abu Dhabi Investment Authority</a></td>
      <td>1,128<sup>40</sup></td>
      <td>1976</td>
      <td>Oil & Gas</td>
    </tr>
    <tr>
      <td><a href="/wiki/UAE">United Arab Emirates</a></td>
      <td></td>
      <td><a href="/wiki/Mubadala">Mubadala Investment Company</a></td>
      <td>302.0<sup>41</sup></td>
      <td>2002</td>
      <td>Oil & Gas</td>
    </tr>
    <tr>
      <td><a href="/wiki/Singapore">Singapore</a></td>
      <td>GIC</td>
      <td><a href="/wiki/GIC">GIC Private Limited</a></td>
      <td>801</td>
      <td>1981</td>
      <td>Non-commodity</td>
    </tr>
    <tr>
      <td><a href="/wiki/Singapore">Singapore</a></td>
      <td></td>
      <td><a href="/wiki/Temasek">Temasek Holdings</a></td>
      <td>382</td>
      <td>1974</td>
      <td>Non-commodity</td>
    </tr>
    <tr>
      <td><a href="/wiki/NoData">No Data Row</a></td>
      <td>NODATA</td>
      <td>Example fund without assets</td>
      <td></td>
      <td>2000</td>
      <td>Non-commodity</td>
    </tr>
  </tbody>
</table>
</body></html>
`;

describe('parseWikipediaRankingsTable — fixture-based scraping', () => {
  const cache = parseWikipediaRankingsTable(FIXTURE_HTML);

  it('indexes funds by normalized abbreviation into record lists', () => {
    // GPF-G → GPFG (normalized: uppercase, strip punctuation). Lookup
    // returns a list so ambiguous abbrevs (e.g. PIF → Saudi vs Palestine
    // on the live article) can be disambiguated at match time.
    const gpfgList = cache.byAbbrev.get('GPFG');
    assert.ok(Array.isArray(gpfgList) && gpfgList.length === 1, 'GPFG should have exactly one candidate in the fixture');
    const [gpfg] = gpfgList;
    assert.equal(gpfg.aum, 2_117_000_000_000);
    assert.equal(gpfg.fundName, 'Government Pension Fund Global');
    assert.equal(gpfg.countryName, 'Norway');
    assert.equal(gpfg.inceptionYear, 1990);

    assert.equal(cache.byAbbrev.get('ADIA')?.[0]?.aum, 1_128_000_000_000);
    assert.equal(cache.byAbbrev.get('GIC')?.[0]?.aum, 801_000_000_000);
  });

  it('indexes funds by normalized fund name for abbrev-less rows', () => {
    // Mubadala and Temasek have no abbreviation in the fixture,
    // so they must still be matchable by fundName.
    const mubadalaList = cache.byFundName.get('mubadala investment company');
    assert.ok(mubadalaList && mubadalaList.length === 1);
    assert.equal(mubadalaList[0].aum, 302_000_000_000);

    const temasekList = cache.byFundName.get('temasek holdings');
    assert.ok(temasekList && temasekList.length === 1);
    assert.equal(temasekList[0].aum, 382_000_000_000);
  });

  it('strips inline HTML + footnote references from the Assets cell', () => {
    // `2,117<sup>37</sup>` — the footnote int must be stripped
    // before parsing. `<sup>` strips to a space so the ref is a
    // separate token, not welded into the number.
    assert.equal(cache.byAbbrev.get('GPFG')[0].aum, 2_117_000_000_000);
  });

  it('skips rows with missing or malformed Assets value', () => {
    assert.equal(cache.byAbbrev.get('NODATA'), undefined);
    assert.equal(cache.byFundName.get('example fund without assets'), undefined);
  });

  it('handles decimal AUM values (e.g. "302.0")', () => {
    const mubadalaList = cache.byFundName.get('mubadala investment company');
    assert.equal(mubadalaList[0].aum, 302_000_000_000);
  });

  it('throws loudly when the expected wikitable is missing', () => {
    assert.throws(() => parseWikipediaRankingsTable('<html><body>no tables here</body></html>'),
      /wikitable not found/);
  });
});

// Separate describe block for the abbrev-collision disambiguation
// case since it requires a fixture with multiple rows sharing an
// abbrev. This is the exact class of bug observed on the live
// Wikipedia article (PIF → Saudi PIF + Palestine Investment Fund).
describe('parseWikipediaRankingsTable — abbrev collisions', () => {
  const COLLIDING_HTML = `
    <table class="wikitable">
      <thead><tr>
        <th>Country</th><th>Abbrev.</th><th>Fund name</th>
        <th>Assets</th><th>Inception</th><th>Origin</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>Saudi Arabia</td><td>PIF</td><td>Public Investment Fund</td>
          <td>925</td><td>1971</td><td>Oil Gas</td>
        </tr>
        <tr>
          <td>Palestine</td><td>PIF</td><td>Palestine Investment Fund</td>
          <td>0.9</td><td>2003</td><td>Non-commodity</td>
        </tr>
      </tbody>
    </table>`;

  it('keeps BOTH colliding records under the shared abbrev key', () => {
    const cache = parseWikipediaRankingsTable(COLLIDING_HTML);
    const pifList = cache.byAbbrev.get('PIF');
    assert.ok(Array.isArray(pifList));
    assert.equal(pifList.length, 2, 'both colliding PIF records must be retained — silent overwrite would shadow Saudi PIF with Palestine');
  });
});

describe('matchWikipediaRecord — manifest-driven lookup', () => {
  const cache = parseWikipediaRankingsTable(FIXTURE_HTML);

  it('matches by abbrev when hints + country align', () => {
    const fund = {
      country: 'NO',
      fund: 'gpfg',
      wikipedia: { abbrev: 'GPF-G', fundName: 'Government Pension Fund Global' },
    };
    const hit = matchWikipediaRecord(fund, cache);
    assert.ok(hit);
    assert.equal(hit.fundName, 'Government Pension Fund Global');
  });

  it('falls back to fund-name match when no abbrev is provided', () => {
    const fund = {
      country: 'AE',
      fund: 'mubadala',
      wikipedia: { fundName: 'Mubadala Investment Company' },
    };
    const hit = matchWikipediaRecord(fund, cache);
    assert.ok(hit);
    assert.equal(hit.aum, 302_000_000_000);
  });

  it('normalizes abbrev punctuation (GPF-G ≡ GPFG)', () => {
    const fund = { country: 'NO', fund: 'gpfg', wikipedia: { abbrev: 'GPFG' } };
    const hit = matchWikipediaRecord(fund, cache);
    assert.ok(hit, 'normalized-abbrev match should succeed');
  });

  it('returns null when no hints match', () => {
    const fund = {
      country: 'NO',
      fund: 'unknown',
      wikipedia: { abbrev: 'XXXX', fundName: 'Nonexistent Fund' },
    };
    assert.equal(matchWikipediaRecord(fund, cache), null);
  });

  it('returns null when manifest entry has no wikipedia hints', () => {
    const fund = { country: 'NO', fund: 'no-hints' };
    assert.equal(matchWikipediaRecord(fund, cache), null);
  });
});

// ── Tier 3b: per-fund Wikipedia article infobox ──
//
// Activated for funds editorially excluded from the /wiki/List_of_
// sovereign_wealth_funds article (Temasek is the canonical case —
// Wikipedia classifies it as a "state holding company" rather than an
// SWF, despite the manifest including it per plan §3.4).
//
// The infobox parser must:
//   - scan rows for "Total assets", "Assets under management", "AUM",
//     "Net assets", "Net portfolio value" labels
//   - detect non-USD currencies (S$, €, £, NOK, etc.) and convert via
//     the FX_TO_USD table
//   - extract the year tag "(2025)" from the value for freshness
//   - skip rows whose currency isn't in the FX table (loud, not silent)

describe('detectCurrency — symbol and code detection', () => {
  it('distinguishes US$ from S$ from $', () => {
    assert.equal(detectCurrency('US$ 1,128 billion'), 'USD');
    assert.equal(detectCurrency('S$ 434 billion'), 'SGD');
    // Bare $ must NOT match US$ or S$ patterns, and must require a
    // digit after.
    assert.equal(detectCurrency('$ 500 billion'), 'USD');
  });

  it('detects Norwegian krone via NOK or kr', () => {
    assert.equal(detectCurrency('NOK 18.7 trillion'), 'NOK');
    assert.equal(detectCurrency('17,500 kr 500 billion'), 'NOK');
  });

  it('detects EUR via € symbol or ISO code', () => {
    assert.equal(detectCurrency('€ 500 million'), 'EUR');
    assert.equal(detectCurrency('500 EUR billion'), 'EUR');
  });

  it('returns null when no currency signal is present', () => {
    assert.equal(detectCurrency('500 billion'), null);
    assert.equal(detectCurrency(''), null);
  });
});

describe('parseWikipediaArticleInfobox — native value + currency extraction', () => {
  // Parser returns { valueNative, currencyNative, aumYear } and does
  // NOT convert to USD — conversion is applied at the seeder level
  // via the project-shared `getSharedFxRates` cache (see
  // scripts/_seed-utils.mjs). Keeping the parser FX-free removes a
  // duplicate copy of the FX table that would drift from the shared
  // one.
  //
  // Mirrors the Temasek infobox structure (abridged). Real row:
  // `<tr><th>Total assets</th><td>S$ 434 billion <i>(2025)</i><sup>2</sup></td></tr>`
  const TEMASEK_INFOBOX = `
    <html><body>
    <table class="infobox vcard">
      <tr><th>Type</th><td>Holding company</td></tr>
      <tr><th>Founded</th><td>25 June 1974</td></tr>
      <tr><th>Total assets</th><td>S$ 434 billion <i>(2025)</i><sup>2</sup></td></tr>
      <tr><th>Owner</th><td>Ministry of Finance</td></tr>
    </table>
    </body></html>
  `;

  it('extracts S$ 434 billion as native SGD value + year tag', () => {
    const hit = parseWikipediaArticleInfobox(TEMASEK_INFOBOX);
    assert.ok(hit, 'Temasek infobox should produce a hit');
    assert.equal(hit.currencyNative, 'SGD');
    assert.equal(hit.valueNative, 434_000_000_000);
    assert.equal(hit.aumYear, 2025);
  });

  it('handles USD-native infoboxes (currency detected as USD)', () => {
    const html = `<table class="infobox">
      <tr><th>AUM</th><td>US$ 1,500 billion (2025)</td></tr>
    </table>`;
    const hit = parseWikipediaArticleInfobox(html);
    assert.ok(hit);
    assert.equal(hit.currencyNative, 'USD');
    assert.equal(hit.valueNative, 1_500_000_000_000);
  });

  it('parses trillion-unit values (NOK 18.7 trillion)', () => {
    const html = `<table class="infobox">
      <tr><th>Net assets</th><td>NOK 18.7 trillion (2025)</td></tr>
    </table>`;
    const hit = parseWikipediaArticleInfobox(html);
    assert.ok(hit);
    assert.equal(hit.currencyNative, 'NOK');
    assert.equal(hit.valueNative, 18_700_000_000_000);
  });

  it('returns null when no AUM-labeled row is present', () => {
    const html = `<table class="infobox">
      <tr><th>Type</th><td>Holding company</td></tr>
    </table>`;
    assert.equal(parseWikipediaArticleInfobox(html), null);
  });

  it('returns null when the infobox itself is missing', () => {
    assert.equal(parseWikipediaArticleInfobox('<html>no infobox</html>'), null);
  });
});

describe('lookupUsdRate — project-shared FX integration', () => {
  // Verifies the parser → FX conversion pipeline uses the project's
  // canonical FX source (scripts/_seed-utils.mjs SHARED_FX_FALLBACKS +
  // getSharedFxRates Redis cache) rather than a duplicate table.

  it('returns 1.0 for USD regardless of rate map', () => {
    assert.equal(lookupUsdRate('USD', {}), 1.0);
    assert.equal(lookupUsdRate('USD', null), 1.0);
    assert.equal(lookupUsdRate('USD', { USD: 999 }), 1.0);
  });

  it('prefers the live rate map over the static fallback', () => {
    // Simulate getSharedFxRates returning a fresh Yahoo rate. The static
    // fallback has SGD=0.74; the live rate could drift (e.g. 0.751).
    assert.equal(lookupUsdRate('SGD', { SGD: 0.751 }), 0.751);
  });

  it('falls back to SHARED_FX_FALLBACKS when the live rate is missing', () => {
    assert.equal(lookupUsdRate('SGD', {}), SHARED_FX_FALLBACKS.SGD);
    assert.equal(lookupUsdRate('NOK', { EUR: 1.05 }), SHARED_FX_FALLBACKS.NOK);
  });

  it('returns null for unknown currencies (caller skips the fund)', () => {
    assert.equal(lookupUsdRate('ZZZ', {}), null);
    assert.equal(lookupUsdRate('XXX', { XXX: 0 }), null);
  });

  it('converts Temasek S$ 434B end-to-end via shared fallback table', () => {
    const hit = parseWikipediaArticleInfobox(`
      <table class="infobox"><tr><th>Total assets</th><td>S$ 434 billion (2025)</td></tr></table>
    `);
    const rate = lookupUsdRate(hit.currencyNative, {});
    const aumUsd = hit.valueNative * rate;
    // 434B × 0.74 = 321.16B. Matches SHARED_FX_FALLBACKS.SGD.
    assert.ok(aumUsd > 300_000_000_000 && aumUsd < 340_000_000_000,
      `expected ~US$ 320B, got ${aumUsd}`);
  });
});

describe('validate — reject null-object masquerading as object', () => {
  // `typeof null === 'object'` in JS, so a bare `typeof x === 'object'`
  // would let { countries: null } through and break downstream. This
  // test pins the strict non-null check.

  it('rejects { countries: null }', () => {
    assert.equal(validate({ countries: null }), false);
  });

  it('rejects missing countries field', () => {
    assert.equal(validate({}), false);
    assert.equal(validate(null), false);
    assert.equal(validate(undefined), false);
  });

  it('rejects array countries (typeof [] === object too)', () => {
    assert.equal(validate({ countries: [] }), false);
  });

  it('accepts empty object (during Railway-cron bake-in window)', () => {
    assert.equal(validate({ countries: {} }), true);
  });

  it('accepts populated countries', () => {
    assert.equal(validate({ countries: { NO: { funds: [] } } }), true);
  });
});

describe('parseWikipediaRankingsTable — nested-table depth awareness', () => {
  // Wikipedia occasionally embeds mini-tables (sort helpers, footnote
  // boxes) inside a wikitable cell. A lazy `[\s\S]*?</table>` regex
  // would stop at the FIRST `</table>` and silently drop every row
  // after the cell containing the nested table. The depth-aware
  // extractor must walk the full open/close pair.

  it('does not truncate at a nested </table> inside a cell', () => {
    const html = `
      <table class="wikitable">
        <tr><th>Country</th><th>Abbrev.</th><th>Fund</th><th>Assets</th><th>Inception</th></tr>
        <tr>
          <td>Norway</td><td>GPF-G</td>
          <td>Government Pension Fund Global
            <table class="mini-sort-helper"><tr><td>nested</td></tr></table>
          </td>
          <td>2000</td><td>1990</td>
        </tr>
        <tr>
          <td>UAE</td><td>ADIA</td>
          <td>Abu Dhabi Investment Authority</td>
          <td>1128</td><td>1976</td>
        </tr>
      </table>
    `;
    const cache = parseWikipediaRankingsTable(html);
    // Without depth awareness, ADIA would be silently dropped because
    // the nested </table> inside GPF-G's cell would close the outer
    // match at row 1.
    assert.ok(cache.byAbbrev.get('ADIA')?.[0]?.aum === 1_128_000_000_000,
      'ADIA must survive — nested </table> in a prior cell should not truncate the wikitable');
    assert.ok(cache.byAbbrev.get('GPFG')?.[0]?.aum === 2_000_000_000_000);
  });
});

describe('parseWikipediaRankingsTable — aumYear accuracy', () => {
  it('sets aumYear=null for list-article rows (no per-row data-year annotation)', () => {
    const html = `
      <table class="wikitable">
        <tr><th>Country</th><th>Abbrev.</th><th>Fund</th><th>Assets</th><th>Inception</th></tr>
        <tr><td>Norway</td><td>GPF-G</td><td>Government Pension Fund Global</td><td>2117</td><td>1990</td></tr>
      </table>
    `;
    const cache = parseWikipediaRankingsTable(html);
    const gpfg = cache.byAbbrev.get('GPFG')?.[0];
    assert.ok(gpfg);
    assert.equal(gpfg.aumYear, null,
      'aumYear must be null — the list article publishes no per-row data-year, and claiming the scrape year would mislead freshness auditors');
    // Infobox path (Tier 3b) sets a real aumYear from "(YYYY)" tag —
    // see the separate infobox test block for that contract.
  });
});

describe('declareRecords — partial-seed guard for multi-fund countries', () => {
  // Regression: for multi-fund countries (AE = ADIA + Mubadala,
  // SG = GIC + Temasek) a single scraper drift would silently publish
  // a partial totalEffectiveMonths if we counted "any fund matched"
  // as a successful country-seed. declareRecords MUST only count
  // countries with completeness === 1.0 so a secondary-fund drift
  // drops the seed-health record count and triggers the operational
  // alarm, rather than leaking an under-weighted total into the
  // ranking.

  it('counts only countries where all manifest funds matched', () => {
    const data = {
      countries: {
        NO: { funds: [{}], expectedFunds: 1, matchedFunds: 1, completeness: 1.0 },
        AE: { funds: [{}, {}], expectedFunds: 2, matchedFunds: 2, completeness: 1.0 },
        SG: { funds: [{}], expectedFunds: 2, matchedFunds: 1, completeness: 0.5 }, // partial
      },
    };
    assert.equal(declareRecords(data), 2,
      'SG (partial, completeness=0.5) must NOT count — recordCount stays at 2, not 3');
  });

  it('returns 0 when every country is partial', () => {
    const data = {
      countries: {
        AE: { expectedFunds: 2, matchedFunds: 1, completeness: 0.5 },
        SG: { expectedFunds: 2, matchedFunds: 1, completeness: 0.5 },
      },
    };
    assert.equal(declareRecords(data), 0,
      'all-partial payload must drop recordCount to 0 — the seed-meta alarm surfaces a degraded run');
  });

  it('returns 0 on empty / malformed payload', () => {
    assert.equal(declareRecords({}), 0);
    assert.equal(declareRecords({ countries: {} }), 0);
    assert.equal(declareRecords(null), 0);
    assert.equal(declareRecords(undefined), 0);
  });

  it('ignores entries lacking the completeness field (defensive)', () => {
    // Old payload shape (pre-completeness) must not spuriously count.
    const data = { countries: { XX: { funds: [{}], totalEffectiveMonths: 1 } } };
    assert.equal(declareRecords(data), 0);
  });
});

describe('matchWikipediaRecord — country-disambiguation on abbrev collisions', () => {
  // This replays the exact class of bug observed on the live Wikipedia
  // article: "PIF" resolves to BOTH Saudi Arabia's Public Investment
  // Fund (~$925B) and Palestine's Palestine Investment Fund (~$900M).
  // Without country disambiguation, a naive Map.set overwrites one
  // with the other — Saudi PIF would silently return Palestine's AUM
  // (three orders of magnitude smaller), breaking the score for every
  // Saudi resilience read.
  const COLLIDING_HTML = `
    <table class="wikitable">
      <thead><tr>
        <th>Country</th><th>Abbrev.</th><th>Fund name</th>
        <th>Assets</th><th>Inception</th><th>Origin</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>Saudi Arabia</td><td>PIF</td><td>Public Investment Fund</td>
          <td>925</td><td>1971</td><td>Oil Gas</td>
        </tr>
        <tr>
          <td>Palestine</td><td>PIF</td><td>Palestine Investment Fund</td>
          <td>0.9</td><td>2003</td><td>Non-commodity</td>
        </tr>
      </tbody>
    </table>`;
  const cache = parseWikipediaRankingsTable(COLLIDING_HTML);

  it('picks the Saudi record for fund.country=SA', () => {
    const fund = { country: 'SA', fund: 'pif', wikipedia: { abbrev: 'PIF' } };
    const hit = matchWikipediaRecord(fund, cache);
    assert.ok(hit);
    assert.equal(hit.countryName, 'Saudi Arabia');
    assert.equal(hit.aum, 925_000_000_000);
  });

  it('returns null (not the wrong record) when country is unknown to the disambiguator', () => {
    // Hypothetical fund from a country not in ISO2_TO_WIKIPEDIA_COUNTRY_NAME.
    // Must NOT silently return Saudi's or Palestine's record.
    const fund = { country: 'ZZ', fund: 'pif', wikipedia: { abbrev: 'PIF' } };
    assert.equal(matchWikipediaRecord(fund, cache), null,
      'ambiguous match with no country mapping must return null — silent wrong-country match is the exact bug this test guards against');
  });
});

describe('pickLatestPerCountry — WB mrv>1 per-country latest-non-null selection', () => {
  // Shape mirrors the WB /country/all/indicator/... response's second
  // array. Year order in prod is newest-first per country, but the
  // picking logic must be order-agnostic so a silent upstream re-order
  // doesn't pick a stale year. Regression from the 2026-04-23 prod
  // crash: mrv=1 returned null for KW/QA/AE because they're a year or
  // two behind NO/SA/SG; mrv=5 + pick-latest fixes it. (PR #3352.)
  const NO_2024 = { countryiso3code: 'NOR', date: '2024', value: 163_801_535_479 };
  const NO_2023 = { countryiso3code: 'NOR', date: '2023', value: 157_000_000_000 };
  const KW_2023 = { countryiso3code: 'KWT', date: '2023', value: 63_424_320_849 };
  const KW_2024_NULL = { countryiso3code: 'KWT', date: '2024', value: null };
  const QA_2022 = { countryiso3code: 'QAT', date: '2022', value: 74_520_054_945 };
  const QA_2024_NULL = { countryiso3code: 'QAT', date: '2024', value: null };

  it('returns the most recent non-null value per country even when mrv=1 would pick a null year', () => {
    const out = pickLatestPerCountry([KW_2024_NULL, KW_2023, QA_2024_NULL, QA_2022, NO_2024]);
    assert.deepEqual(out.KW, { importsUsd: 63_424_320_849, year: 2023 });
    assert.deepEqual(out.QA, { importsUsd: 74_520_054_945, year: 2022 });
    assert.deepEqual(out.NO, { importsUsd: 163_801_535_479, year: 2024 });
  });

  it('picks the NEWER year when the array arrives in ascending year order (upstream re-order must not pick stale)', () => {
    const out = pickLatestPerCountry([NO_2023, NO_2024]);
    assert.equal(out.NO.year, 2024);
    assert.equal(out.NO.importsUsd, 163_801_535_479);
  });

  it('picks the newer year when the array arrives in descending year order (prod-observed ordering)', () => {
    const out = pickLatestPerCountry([NO_2024, NO_2023]);
    assert.equal(out.NO.year, 2024);
    assert.equal(out.NO.importsUsd, 163_801_535_479);
  });

  it('drops countries with ONLY null values (WB has no data in the lookback window)', () => {
    // Real ISO-3 code required — a fake one (e.g. 'XYZ') is filtered at the
    // iso3→iso2 lookup stage, never reaching the null-value guard. A
    // regression that deleted the null check entirely would still leave
    // this test green. Using NOR forces the record through the lookup
    // branch so the null-filter is the actual gate under test.
    const out = pickLatestPerCountry([
      { countryiso3code: 'NOR', date: '2024', value: null },
      { countryiso3code: 'NOR', date: '2023', value: null },
    ]);
    assert.equal(out.NO, undefined);
  });

  it('drops records with non-positive values (WB sometimes reports 0 for countries with no trade)', () => {
    const out = pickLatestPerCountry([
      { countryiso3code: 'NOR', date: '2024', value: 0 },
      { countryiso3code: 'NOR', date: '2023', value: -100 },
    ]);
    assert.equal(out.NO, undefined);
  });

  it('handles both iso3 and iso2 country codes (bulk endpoint occasionally uses either)', () => {
    const out = pickLatestPerCountry([
      { countryiso3code: 'NOR', date: '2024', value: 100 },
      { country: { id: 'SA' }, date: '2024', value: 200 },
    ]);
    assert.equal(out.NO.importsUsd, 100);
    assert.equal(out.SA.importsUsd, 200);
  });

  it('enumerates every manifest country in buildCoverageSummary — no silent drops', () => {
    // Regression-guard: AE was silently dropped in the 2026-04-23 prod run
    // with no log line explaining why. The fix requires that every
    // manifest country appear in the summary with an explicit status and
    // reason.
    const manifest = {
      funds: [
        { country: 'AE', fund: 'adia' },
        { country: 'AE', fund: 'mubadala' },
        { country: 'NO', fund: 'gpfg' },
        { country: 'KW', fund: 'kia' },
      ],
    };
    // Simulate: NO fully matched, AE partial (1 of 2), KW missing due to
    // no WB imports.
    const imports = {
      NO: { importsUsd: 163_000_000_000, year: 2024 },
      AE: { importsUsd: 481_000_000_000, year: 2023 },
      // KW absent → summary should show 'missing WB imports'
    };
    const countries = {
      NO: { matchedFunds: 1, expectedFunds: 1, completeness: 1.0 },
      AE: { matchedFunds: 1, expectedFunds: 2, completeness: 0.5 },
      // KW absent
    };
    const summary = buildCoverageSummary(manifest, imports, countries);
    assert.equal(summary.expectedCountries, 3);
    assert.equal(summary.expectedFunds, 4);
    assert.equal(summary.matchedCountries, 2);
    assert.equal(summary.matchedFunds, 2);
    // Sorted alphabetically
    assert.deepEqual(summary.countryStatuses.map((s) => s.country), ['AE', 'KW', 'NO']);
    assert.equal(summary.countryStatuses[0].status, 'partial');
    assert.equal(summary.countryStatuses[1].status, 'missing');
    assert.equal(summary.countryStatuses[1].reason, 'missing WB imports',
      'KW had no imports entry — reason must specifically name the WB import denominator, not a generic "missing"');
    assert.equal(summary.countryStatuses[1].expected, 1,
      'KW expected field must reflect manifest fund count for this country, even when the country was dropped');
    assert.equal(summary.countryStatuses[2].status, 'complete');
    // Every status entry must carry a `reason` key for uniform shape —
    // downstream consumers reading the persisted Redis payload iterate
    // countryStatuses and dereference `.reason` directly. complete/partial
    // use null; missing uses a string. Guard against regressions that
    // drop the key on success paths.
    for (const row of summary.countryStatuses) {
      assert.ok('reason' in row, `${row.country} (${row.status}): reason key must be present in persisted shape even when there's no error`);
    }
    assert.equal(summary.countryStatuses[0].reason, null, 'partial entries use reason=null');
    assert.equal(summary.countryStatuses[2].reason, null, 'complete entries use reason=null');
  });

  it('labels "no fund AUM matched" distinctly from "missing WB imports" so operators can disambiguate', () => {
    // If the import denominator IS present but Wikipedia matching fails
    // for every fund the country owns, the reason must be different —
    // operator investigates Wikipedia, not WB.
    const manifest = { funds: [{ country: 'ZZ', fund: 'zz_fund' }] };
    const imports = { ZZ: { importsUsd: 1_000_000_000, year: 2024 } };
    const countries = {}; // country dropped because no fund matched
    const summary = buildCoverageSummary(manifest, imports, countries);
    assert.equal(summary.countryStatuses[0].status, 'missing');
    assert.equal(summary.countryStatuses[0].reason, 'no fund AUM matched');
  });

  it('mirrors the prod scenario that failed on 2026-04-23 — all 6 manifest countries resolve', () => {
    // Snapshot of the WB mrv=5 response for the 6 manifest countries as
    // probed on 2026-04-23. If WB's data shape shifts, this fixture
    // breaks and the seeder's coverage claim needs re-verification.
    const input = [
      { countryiso3code: 'NOR', date: '2024', value: 163_801_535_479 },
      { countryiso3code: 'SAU', date: '2024', value: 317_011_733_333 },
      { countryiso3code: 'SGP', date: '2024', value: 786_020_626_642 },
      { countryiso3code: 'ARE', date: '2024', value: null },
      { countryiso3code: 'ARE', date: '2023', value: 481_851_599_728 },
      { countryiso3code: 'KWT', date: '2024', value: null },
      { countryiso3code: 'KWT', date: '2023', value: 63_424_320_849 },
      { countryiso3code: 'QAT', date: '2024', value: null },
      { countryiso3code: 'QAT', date: '2023', value: null },
      { countryiso3code: 'QAT', date: '2022', value: 74_520_054_945 },
    ];
    const out = pickLatestPerCountry(input);
    for (const iso2 of ['NO', 'SA', 'SG', 'AE', 'KW', 'QA']) {
      assert.ok(out[iso2], `${iso2} must resolve under mrv=5 pick-latest — this is the 8/8 coverage test`);
    }
    // AE was the silent-drop country in prod: no log line, no record.
    // Lock in that mrv=5 recovers it from the 2023 row.
    assert.equal(out.AE.year, 2023);
    assert.equal(out.AE.importsUsd, 481_851_599_728);
  });
});
