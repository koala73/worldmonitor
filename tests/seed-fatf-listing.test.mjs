// Pin the FATF entry-page parser + listing extractor + publication-date
// inference. Plan 2026-04-25-004 §Component 3.
//
// Tests use realistic HTML fragments (NOT recorded-from-network fixtures
// because FATF rebuilds their site periodically). The fragment shapes
// mirror the patterns observed at
// `https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html`
// as of 2026-02-13. If FATF restructures the page, these tests fail
// loudly and the seeder's `find*Link` regex needs an update.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findPublicationLink,
  extractListedCountries,
  extractPublicationDate,
  validate,
} from '../scripts/seed-fatf-listing.mjs';

describe('findPublicationLink — entry-page anchor scan', () => {
  const ENTRY_PAGE_2026 = `
    <html><body>
      <h2>Black & grey lists</h2>
      <p>Latest FATF actions:</p>
      <ul>
        <li><a href="/en/publications/Fatfrecommendations/high-risk-jurisdictions-2026.html">High-risk jurisdictions subject to a call for action — February 2026</a></li>
        <li><a href="/en/publications/Fatfrecommendations/increased-monitoring-feb-2026.html">Jurisdictions under increased monitoring — February 2026</a></li>
      </ul>
    </body></html>
  `;

  it('finds the "high-risk" (black list) publication URL', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'high-risk');
    assert.match(url, /high-risk-jurisdictions/);
    assert.match(url, /^https:\/\/www\.fatf-gafi\.org\//, 'must resolve relative href against FATF origin');
  });

  it('finds the "increased monitoring" (grey list) publication URL', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'increased monitoring');
    assert.match(url, /increased-monitoring/);
  });

  it('returns null when label is absent (loud failure for parser regression)', () => {
    const sterile = '<html><body><p>Nothing here</p></body></html>';
    assert.equal(findPublicationLink(sterile, 'high-risk'), null);
  });

  it('case-insensitive label match', () => {
    const url = findPublicationLink(ENTRY_PAGE_2026, 'HIGH-RISK');
    assert.ok(url);
  });
});

describe('extractListedCountries — country-name lookup from publication HTML', () => {
  // Build a minimal name lookup mirroring the structure of country-names.json.
  function buildLookup() {
    return new Map([
      ['north korea', 'KP'],
      ['democratic peoples republic of korea', 'KP'],
      ['iran', 'IR'],
      ['islamic republic of iran', 'IR'],
      ['myanmar', 'MM'],
      ['burma', 'MM'],
      ['nigeria', 'NG'],
      ['south africa', 'ZA'],
    ]);
  }

  it('extracts country names from H2 / strong tag patterns (FATF black-list page)', () => {
    const html = `
      <html><body>
        <h2>High-Risk Jurisdictions Subject to a Call for Action</h2>
        <p>Updated February 2026</p>
        <h3>Democratic People's Republic of Korea</h3>
        <p>The FATF urges members to apply enhanced due diligence...</p>
        <h3>Iran</h3>
        <p>Iran remains subject to a call for countermeasures.</p>
        <h3>Myanmar</h3>
      </body></html>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('KP'), 'must extract DPRK');
    assert.ok(listed.has('IR'), 'must extract Iran');
    assert.ok(listed.has('MM'), 'must extract Myanmar');
  });

  it('extracts country names from grey-list publication (typical 15-25 countries)', () => {
    const html = `
      <html><body>
        <h2>Jurisdictions under Increased Monitoring</h2>
        <ul>
          <li>Nigeria</li>
          <li>South Africa</li>
        </ul>
      </body></html>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('NG'));
    assert.ok(listed.has('ZA'));
  });

  it('ignores long paragraphs that happen to mention country names', () => {
    // Defensive: paragraph text > 80 chars is skipped to avoid false matches.
    const html = `
      <h3>Iran</h3>
      <p>The FATF expressed concern about Iran's continued failure to address financial system risks across many jurisdictions including but not limited to Iran's own. This is a long paragraph and should not match.</p>
    `;
    const { listed } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('IR'), 'h3 match still works');
    // The long paragraph mentioning Iran does NOT independently double-count.
    assert.equal(listed.size, 1);
  });

  it('flags short capitalized text nodes that look like missing country names', () => {
    // FATF introduces a new spelling not in country-names.json — must
    // surface as unmatchedCandidate so ops can extend the aliases map.
    const html = `
      <html><body>
        <h3>Mauretania</h3>  <!-- alternate spelling not in lookup -->
        <h3>Iran</h3>
      </body></html>
    `;
    const { listed, unmatchedCandidates } = extractListedCountries(html, buildLookup());
    assert.ok(listed.has('IR'), 'matched country still resolves');
    assert.ok(unmatchedCandidates.has('Mauretania'), 'unknown spelling surfaces as unmatched candidate');
  });

  it('does NOT flag known FATF section headers as unmatched', () => {
    const html = `
      <html><body>
        <h2>High-Risk Jurisdictions Subject to a Call for Action</h2>
        <h3>Iran</h3>
      </body></html>
    `;
    const { unmatchedCandidates } = extractListedCountries(html, buildLookup());
    // Section headers are too long (>80 chars after stripHtml is fine) AND
    // they're in the SECTION_NOISE allow-list. None should appear as
    // unmatched candidates.
    assert.equal(unmatchedCandidates.size, 0, 'section headers must not be flagged as unmatched country names');
  });
});

describe('extractPublicationDate — slug + header inference', () => {
  it('parses YYYY-MM from URL slug', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo/high-risk-2026-02.html',
      '<html></html>',
    );
    assert.equal(date, '2026-02-01');
  });

  it('falls back to "February 2026" header when URL slug is dateless', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo/high-risk.html',
      '<h2>High-Risk Jurisdictions — February 2026</h2>',
    );
    assert.equal(date, '2026-02-01');
  });

  it('falls back to current date when neither URL nor header has a date', () => {
    const date = extractPublicationDate(
      'https://www.fatf-gafi.org/en/publications/foo.html',
      '<html><body>No date here</body></html>',
    );
    // Just check it's a valid YYYY-MM-DD; can't pin the value because it's "today".
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('validate', () => {
  it('rejects payload missing the listings field', () => {
    assert.equal(validate({}), false);
  });

  it('rejects payload with no black-listed jurisdiction (DPRK has been on call-for-action since 2011)', () => {
    const onlyGrey = {};
    for (let i = 0; i < 15; i++) onlyGrey[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings: onlyGrey }), false);
  });

  it('rejects payload with too few grey-listed jurisdictions (parser likely failed)', () => {
    // Floor tightened from 8 → 12 — historical FATF grey-list size has
    // been 15+ since 2020. A grey count below 12 indicates real upstream
    // failure or parser drift.
    const listings = { KP: 'black' };
    for (let i = 0; i < 10; i++) listings[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings }), false);
  });

  it('accepts payload with at least 1 black + 12 grey', () => {
    const listings = { KP: 'black' };
    for (let i = 0; i < 14; i++) listings[`X${i.toString().padStart(2, '0')}`] = 'gray';
    assert.equal(validate({ listings }), true);
  });
});
