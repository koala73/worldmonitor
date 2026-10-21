import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evidenceNumbersGrounded, isEvidenceLimitClaim } from '../shared/brief-claim-rules.js';

const CII = {
  id: 'E1', kind: 'cii', value: '62.3 of 100 (Elevated)',
  factText: 'Egypt has a Country Instability Index score of 62.3 of 100, in the Elevated band, as of Sep 23, 2026.',
};
const FISCAL = {
  id: 'E2', kind: 'resilience-dimension', value: '28 of 100',
  factText: "Egypt's fiscal space scores 28 of 100 in the Country Resilience Index (Aug 29, 2026 snapshot).",
};
const ADVISORY = {
  id: 'E3', kind: 'advisory', value: 'Exercise Increased Caution',
  factText: 'The most severe government travel advisory World Monitor tracks for Egypt is Exercise Increased Caution, as of Sep 23, 2026.',
};
const MARKET = {
  id: 'E4', kind: 'market', value: '41%',
  factText: "A Polymarket market related to Egypt, 'Egypt IMF deal by December 31?', priced Yes at 41% on Sep 23, 2026; it closes Dec 31, 2026.",
};
const SANCTIONS = {
  id: 'E5', kind: 'sanctions', value: '1,234',
  factText: 'Egypt is linked to 1,234 US OFAC and Canada SEMA sanctions designations, as of Sep 23, 2026.',
};

describe('evidenceNumbersGrounded', () => {
  it('accepts the cited value, its 0-100 scale and its dates', () => {
    for (const [claim, cited] of [
      ['Egypt has a Country Instability Index score of 62.3 of 100.', [CII]],
      ['Egypt has a Country Instability Index score of 62.3 of 100 as of Sep 23, 2026.', [CII]],
      ["Egypt's fiscal space scores 28 of 100 in the Country Resilience Index.", [FISCAL, ADVISORY]],
      ['Polymarket prices an Egypt IMF deal by December 31 at 41%, closing Dec 31, 2026.', [MARKET]],
      ['Egypt is linked to 1,234 US OFAC and Canada SEMA sanctions designations.', [SANCTIONS]],
      ['The travel advisory for Egypt is Exercise Increased Caution.', [ADVISORY]],
    ]) {
      assert.equal(evidenceNumbersGrounded(claim, cited), true, claim);
    }
  });

  it('rejects numbers borrowed from the as-of date, the scale or another metric', () => {
    for (const [claim, cited] of [
      ['Egypt has a Country Instability Index score of 23 of 100.', [CII]],
      ['Egypt has a Country Instability Index score of 100.', [CII]],
      ['Egypt has a Country Instability Index score of 9.', [CII]],
      ['Egypt scores 2026 on the Country Instability Index.', [CII]],
      ['Egypt has a Country Instability Index score of 62.3 of 100 as of Sep 24, 2026.', [CII]],
      ['The travel advisory for Egypt has been raised 3 times.', [ADVISORY]],
    ]) {
      assert.equal(evidenceNumbersGrounded(claim, cited), false, claim);
    }
  });

  it('rejects a numeric claim that cites two numbered data points, so values cannot swap', () => {
    assert.equal(evidenceNumbersGrounded('Egypt scores 28 of 100 on the Country Instability Index and 62.3 of 100 on fiscal space.', [CII, FISCAL]), false);
    assert.equal(evidenceNumbersGrounded('Egypt has a Country Instability Index score of 62.3 of 100.', [CII, FISCAL]), false);
    assert.equal(evidenceNumbersGrounded('Egypt faces elevated instability and weak fiscal space.', [CII, FISCAL]), true, 'no numbers, nothing to swap');
  });
});

describe('isEvidenceLimitClaim', () => {
  it('flags statements about the evidence instead of about the country', () => {
    for (const claim of [
      'The supplied headlines do not establish this.',
      'The headlines do not say what this means for Egypt.',
      'No data is available on the outlook for Egypt.',
      'The sources do not specify any risks.',
      'This is not established by the supplied titles.',
      'World Monitor data does not indicate a forecast.',
      'It is unclear from the headlines whether talks will continue.',
    ]) {
      assert.equal(isEvidenceLimitClaim(claim), true, claim);
    }
  });

  it('leaves factual claims with negations alone', () => {
    for (const claim of [
      'Egypt does not recognize the South Sudan dam agreement.',
      'The court did not establish a date for the retrial.',
      'No ships transited the Suez Canal on Tuesday.',
      'Sources close to the talks say a deal is near.',
    ]) {
      assert.equal(isEvidenceLimitClaim(claim), false, claim);
    }
  });
});
