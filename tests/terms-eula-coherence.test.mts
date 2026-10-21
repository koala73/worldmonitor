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

/**
 * One counterparty, named the same way everywhere.
 *
 * The review's first P0 was that no document named a legal entity — you cannot
 * sign, serve notice on, or sue a description. Now that the party is
 * "World Monitor FZ LLC", the failure mode moves: one document gets updated and
 * the others keep describing an unnamed operator, so a buyer's counsel finds
 * two different counterparties across the agreement they are accepting.
 */
describe('every document names the same legal entity', () => {
  const LEGAL_NAME = /World Monitor FZ LLC/;

  for (const [label, path] of [
    ['Terms', 'docs/terms.mdx'],
    ['EULA', 'docs/eula.mdx'],
    ['Privacy Policy', 'docs/privacy.mdx'],
    ['Terms (zh)', 'docs/zh/terms.mdx'],
    ['EULA (zh)', 'docs/zh/eula.mdx'],
    ['Privacy Policy (zh)', 'docs/zh/privacy.mdx'],
  ]) {
    it(`${label} names the entity`, () => {
      assert.match(visible(read(path)), LEGAL_NAME, `${path} must name the contracting party, not describe it`);
    });
  }

  it('no document still describes the party without naming it', () => {
    for (const path of ['docs/terms.mdx', 'docs/eula.mdx', 'docs/privacy.mdx']) {
      assert.doesNotMatch(
        visible(read(path)),
        /World Monitor, based in the United Arab Emirates/,
        `${path} still carries the pre-entity wording`,
      );
    }
  });
});

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
    // The cap only does work in the mixed case: a paying customer whose claim
    // arises from a free surface. For a user who pays nothing the general cap
    // already resolves to USD 100, so a clause that does not say "including
    // where you also hold a paid plan" is pure restatement.
    assert.match(terms, /capped at USD 100 in aggregate — including where you also hold a paid plan/i);
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

describe('the self-serve Terms keep what protects a buyer and us', () => {
  const required: Array<[string, RegExp]> = [
    ['a refund trigger when a paid feature is withdrawn', /refund the unused portion of prepaid fees/i],
    ['a beta carve-out', /beta, preview, or experimental/i],
    ['a sanctions and export-control restriction', /sanctions or export-control law/i],
    ['a high-risk-use prohibition', /high-risk system/i],
    ['the indemnity we receive', /You will defend us against third-party claims/i],
    ['liability carve-outs', /These caps do not apply to/i],
    ['usage verification without an audit right', /no audit of your premises/i],
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

/**
 * The self-serve / Enterprise line.
 *
 * A first pass at this review implemented the reviewer's warranty, company
 * indemnity, confidentiality and audit clauses directly into the click-through
 * Terms. Those are Master Services Agreement concessions — the reference ToU
 * template grants none of them — and click-wrapping them hands negotiated-deal
 * protections to a $99/month self-serve buyer for nothing.
 *
 * They are Enterprise inventory instead. This is the guard that keeps them
 * there: adding a warranty or an indemnity back into the self-serve Terms
 * fails, and so does quietly dropping the section that tells a buyer those
 * protections exist and where.
 */
describe('Enterprise protections are not bundled into self-serve', () => {
  const NOT_IN_SELF_SERVE: Array<[string, RegExp]> = [
    ['a performance warranty', /perform substantially in accordance with our published documentation/i],
    ['an exclusive warranty remedy', /sole and exclusive remedy/i],
    ['an indemnity from us', /We will defend you against a third-party claim/i],
    ['a mutual confidentiality agreement', /^## Confidentiality/m],
    ['a guaranteed cure period', /\b10 days to put it right\b/i],
    ['a cap on the customer\'s own liability', /Your liability to us.{0,40}capped/i],
    // Decided, not omitted: arbitration and class-action waivers are Enterprise
    // terms. The reference ToU template makes its arbitration clause the
    // headline, so the absence here has to be deliberate and stay deliberate.
    ['an arbitration or class-action waiver', /\b(binding arbitration|class action waiver|class-action waiver|jury trial)\b/i],
  ];

  for (const [what, pattern] of NOT_IN_SELF_SERVE) {
    it(`the Terms do not grant ${what}`, () => {
      assert.doesNotMatch(
        terms,
        pattern,
        `${what} is an Enterprise term — granting it in click-through Terms gives it away with every self-serve plan`,
      );
    });
  }

  it('the negotiated-terms section offers, and does not commit', () => {
    // An earlier draft listed a warranty, an indemnity, an NDA, an SLA and a
    // DPA as things Enterprise "adds" — entitlement grammar for documents that
    // do not exist yet, and this guard was enforcing that we keep saying it.
    // Naming what a negotiated agreement CAN cover is fine; promising it is not.
    const section = terms.slice(terms.indexOf('## Enterprise and negotiated terms'));
    assert.ok(section.length > 0, 'the Terms must say which plans they cover and where the rest goes');

    assert.match(section, /Free, Pro, Pro Business, API Starter, and API Business/, 'name the plans these Terms cover');
    assert.match(section, /separate signed agreement/i);
    assert.match(
      section,
      /None of that is included in, or claimable under, any self-serve plan/i,
      'a self-serve buyer must not be able to claim a negotiated protection',
    );
    assert.match(
      section,
      /nothing in this section commits us to agree to any of it/i,
      'listing what a negotiated agreement can cover must not become a promise to provide it',
    );
  });

  it('the EULA draws the same line, in the same grammar', () => {
    assert.match(eula, /a signed order form can differ from this/i);
    assert.match(eula, /not part of any self-serve plan/i);
    assert.match(
      eula,
      /nothing here commits us to any particular terms/i,
      'the EULA must offer negotiation without promising an outcome',
    );
  });

  it('the disclaimer is unqualified again, now that no warranty sits above it', () => {
    assert.doesNotMatch(terms, /Except for the warranty above/i);
    assert.match(terms, /the Service is provided "as is" and "as available"/i);
  });
});
