/**
 * The Terms and the EULA have to agree, clause by clause.
 *
 * An external review of the Terms found most of its P0 items were not missing
 * text but *disagreements*: the EULA prohibited decisions about individuals
 * while the product ships sanctions screening; the EULA made quotas part of the
 * licence while ranking the pricing page that sets them last in precedence; the
 * EULA's output-rights table required R4 to be internal-use-only for the term
 * while its termination section never said to delete it; one document said
 * facts are unowned and the other claimed to own them.
 *
 * Each case below pins one of those pairings. They are the assertions that
 * would have caught the contradiction, not restatements of the fix.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Only what a reader sees: a review comment is not a term. */
const visible = (mdx: string) =>
  mdx.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const eula = visible(read('docs/eula.mdx'));
const terms = visible(read('docs/terms.mdx'));

describe('the compliance carve-out exists wherever the prohibition does', () => {
  // We publish OFAC SDN data and live aircraft tracking. Sanctions screening is
  // a rights-affecting decision about a named individual, so a flat prohibition
  // outlaws the product's own use case.
  for (const [label, text] of [['EULA', eula], ['Terms', terms]]) {
    it(`${label} prohibits rights-affecting decisions about individuals`, () => {
      assert.match(text, /decisions about an individual that affect their rights/i);
    });

    it(`${label} carves out compliance, research and journalism`, () => {
      assert.match(text, /sanctions screening/i, `${label} must name sanctions screening as permitted`);
      assert.match(text, /know-your-customer/i);
      assert.match(text, /journalism/i);
    });
  }
});

describe('quotas cannot be narrowed by editing a pricing page', () => {
  // EULA §2 ranks pricing pages and documentation last in precedence, while
  // §6.3 makes published limits part of the licence. Without a freeze, licence
  // scope moves when a marketing page is edited mid-term.
  it('the EULA ranks documentation and pricing pages last', () => {
    assert.match(eula, /plan descriptions, pricing pages, and documentation/i);
  });

  for (const [label, text] of [['EULA', eula], ['Terms', terms]]) {
    it(`${label} freezes the published allowance for the paid period`, () => {
      assert.match(
        text,
        /(published for your plan|apply for the remainder of that billing period)/i,
        `${label} must fix quotas for the period already paid for`,
      );
      assert.match(text, /take effect at your next renewal/i);
    });
  }
});

describe('R4 is deleted when the plan ends', () => {
  it('the EULA output-rights table makes R4 internal-use-only for the term', () => {
    assert.match(eula, /R4 — Full source content/i);
    assert.match(eula, /internal use only/i);
  });

  it('the EULA termination section says to delete it', () => {
    const termination = eula.slice(eula.indexOf('## 10.'));
    assert.match(
      termination,
      /delete cached R4 Source Content/i,
      'EULA §5 requires R4 to lapse with the plan; §10 has to say so',
    );
  });

  it('the Terms describe the same end state', () => {
    assert.match(terms, /delete cached R4 Source Content/i);
  });
});

describe('facts are described the same way in both documents', () => {
  it('the EULA does not claim to own what it says is unowned', () => {
    assert.match(eula, /Facts are not owned/i, 'section 5 states the principle');
    const ownership = eula.slice(eula.indexOf('## 9.'));
    assert.doesNotMatch(
      ownership,
      /and all associated intellectual property[\s\S]{0,80}the Derived Facts we compute/i,
      'the ownership section must not re-claim the facts section 5 disclaims',
    );
    assert.match(ownership, /selection, compilation and arrangement/i);
  });

  it('the Terms state the same position', () => {
    assert.match(terms, /individual facts are not protected by copyright/i);
    assert.match(terms, /selection, compilation, and arrangement/i);
  });
});

describe('a change to a paid subscription is noticed the same way in both', () => {
  for (const [label, text] of [['EULA', eula], ['Terms', terms]]) {
    it(`${label} ties material changes to the next billing period`, () => {
      assert.match(text, /material changes take effect at the start of your next billing period/i);
      assert.match(text, /30 days' notice/i);
    });
  }
});

describe('the free tier is governed on its own terms', () => {
  it('the Terms carve it into a section with its own cap', () => {
    assert.match(terms, /## Free and anonymous access/);
    assert.match(terms, /free and anonymous access will not exceed USD 100/i);
    assert.match(
      terms,
      /Only these sections apply to free and anonymous access/i,
      'an anonymous caller must not implicitly accept commitments that assume a paid account',
    );
  });

  it('the EULA free row points at it', () => {
    assert.match(eula, /\| \*\*Free \/ anonymous\*\*/);
    assert.match(eula, /Free and anonymous access/i);
  });
});

describe('the paid commitments the review asked for exist', () => {
  const required: Array<[string, RegExp]> = [
    ['a refund trigger when a paid feature is withdrawn', /refund the unused portion of prepaid fees/i],
    ['a beta carve-out', /beta, preview, or experimental/i],
    ['a sanctions and export-control restriction', /sanctions or export-control law/i],
    ['a high-risk-use prohibition', /high-risk system/i],
    ['a performance warranty', /perform substantially in accordance with our published documentation/i],
    ['an exclusive remedy for that warranty', /sole and exclusive remedy/i],
    ['an IP indemnity we give', /We will defend you against a third-party claim/i],
    ['indemnity carve-outs', /R3 and R4 Source Content/i],
    ['liability carve-outs', /These caps do not apply to/i],
    ['a cure period before suspension', /10 days to put it right/i],
    ['mutual confidentiality', /## Confidentiality/],
    ['an express permission to benchmark', /publish benchmarks and reviews/i],
    ['compliance verification without an audit right', /no audit of your premises/i],
    ['taxes', /exclusive of VAT/i],
    ['failed-payment handling', /If a payment fails/i],
    ['entire agreement', /Entire agreement/i],
    ['severability', /Severability/i],
    ['assignment', /Assignment/i],
    ['notices', /Notices\./],
    ['force majeure', /Force majeure/i],
  ];

  for (const [what, pattern] of required) {
    it(`the Terms state ${what}`, () => {
      assert.match(terms, pattern);
    });
  }
});
