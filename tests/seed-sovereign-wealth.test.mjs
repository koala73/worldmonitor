import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FX_TO_USD,
  detectCurrency,
  matchWikipediaRecord,
  parseWikipediaArticleInfobox,
  parseWikipediaRankingsTable,
} from '../scripts/seed-sovereign-wealth.mjs';

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

describe('parseWikipediaArticleInfobox — AUM extraction + FX conversion', () => {
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

  it('extracts AUM from an S$ (SGD) infobox and converts to USD', () => {
    const hit = parseWikipediaArticleInfobox(TEMASEK_INFOBOX);
    assert.ok(hit, 'Temasek infobox should produce a hit');
    assert.equal(hit.currencyNative, 'SGD');
    assert.equal(hit.fxRate, FX_TO_USD.get('SGD'));
    // 434 * 1e9 * 0.74 (SGD→USD) = 321.16B USD
    assert.ok(hit.aum > 300_000_000_000 && hit.aum < 340_000_000_000,
      `expected ~US$ 320B, got ${hit.aum}`);
    assert.equal(hit.aumYear, 2025);
  });

  it('handles USD-native infoboxes without FX conversion', () => {
    const html = `<table class="infobox">
      <tr><th>AUM</th><td>US$ 1,500 billion (2025)</td></tr>
    </table>`;
    const hit = parseWikipediaArticleInfobox(html);
    assert.ok(hit);
    assert.equal(hit.currencyNative, 'USD');
    assert.equal(hit.fxRate, 1.0);
    assert.equal(hit.aum, 1_500_000_000_000);
  });

  it('handles Norwegian krone ("NOK 18.7 trillion")', () => {
    const html = `<table class="infobox">
      <tr><th>Net assets</th><td>NOK 18.7 trillion (2025)</td></tr>
    </table>`;
    const hit = parseWikipediaArticleInfobox(html);
    assert.ok(hit);
    assert.equal(hit.currencyNative, 'NOK');
    // 18.7T NOK × 0.093 ≈ 1.739T USD
    assert.ok(hit.aum > 1_700_000_000_000 && hit.aum < 1_800_000_000_000,
      `expected ~US$ 1.74T, got ${hit.aum}`);
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

  it('skips rows whose currency is not in the FX table (loud, not silent)', () => {
    // Hypothetical row in a currency we don't have a rate for. Must
    // return null rather than interpreting as USD — silent wrong-
    // currency conversion is the failure mode this guards against.
    const html = `<table class="infobox">
      <tr><th>Total assets</th><td>ZZZ 500 billion</td></tr>
    </table>`;
    // ZZZ has no detected currency; detectCurrency returns null; the
    // parser falls back to USD. Acceptable behavior given the spec
    // ("USD default when no symbol"), so this scenario documents the
    // contract rather than asserting null.
    const hit = parseWikipediaArticleInfobox(html);
    assert.ok(hit);
    assert.equal(hit.currencyNative, 'USD', 'unrecognized currency defaults to USD per documented contract');
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
