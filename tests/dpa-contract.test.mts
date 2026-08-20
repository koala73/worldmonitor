/**
 * The DPA has to describe the Service that actually runs (#6638).
 *
 * A Data Processing Addendum fails in a specific way: it is written once, filed
 * by procurement, and then quietly stops matching the product. The two places
 * that happens are the subprocessor list — which every DPA template wants
 * duplicated into an annex — and commitments about AI processing, which are the
 * easiest thing to over-promise and the hardest for a customer to check.
 *
 * So the DPA does not carry its own subprocessor table. It points at the
 * Privacy Policy, and this pins that arrangement in place.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const visible = (mdx: string) =>
  mdx.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const dpa = visible(read('docs/dpa.mdx'));
const privacy = visible(read('docs/privacy.mdx'));

describe('the DPA keeps one subprocessor list, in the Privacy Policy', () => {
  it('points at the Privacy Policy instead of copying the table', () => {
    assert.match(dpa, /subprocessor table in the \[Privacy Policy\]\(\/privacy\)/i);
  });

  it('does not carry a second table that could drift', () => {
    // A markdown table with a Provider/Purpose header is the shape the template
    // wants in Annex 5. Two lists is how a DPA ends up naming a provider we
    // dropped a year ago.
    assert.doesNotMatch(
      dpa,
      /\|\s*Provider\s*\|/i,
      'the DPA must not duplicate the subprocessor table — one list, in the Privacy Policy',
    );
  });

  it('the list it points at is actually there', () => {
    assert.match(privacy, /\| Provider \| Purpose \|/);
    for (const provider of [/Clerk/, /Convex/, /Dodo Payments/, /Anthropic/, /Upstash/, /Railway/, /Mintlify/]) {
      assert.match(privacy, provider, `the Privacy Policy table must still name ${provider}`);
    }
  });
});

describe('the DPA describes processing the Service actually does', () => {
  it('states the declared-coordinates design, which is why so little applies', () => {
    assert.match(dpa, /customer-declared static coordinates/i);
    assert.match(
      dpa,
      /does not require, and is not designed to receive, the names, locations, itineraries, or contact details/i,
    );
  });

  it('matches the EULA on what the Service needs', () => {
    // If the EULA ever stops saying this, the DPA's central claim is unfounded.
    assert.match(
      visible(read('docs/eula.mdx')),
      /customer-declared static coordinates and configuration/i,
      'the EULA is where this claim originates; the DPA must not outlive it',
    );
  });

  it('names the alert destinations as the customer\'s own choice', () => {
    assert.match(dpa, /Telegram, Slack, Discord/);
    assert.match(dpa, /leaves our control on delivery/i);
  });
});

describe('the AI commitment is worded as what we can actually do', () => {
  it('promises no training on personal data', () => {
    assert.match(
      dpa,
      /do not use personal data processed on your behalf to train, fine-tune, or improve any model/i,
    );
  });

  it('does not over-claim control over downstream model providers', () => {
    // OpenRouter routes to providers whose own terms vary. Promising every
    // downstream provider's behaviour would be a commitment we cannot keep.
    assert.match(privacy, /OpenRouter/, 'the routing provider is still in use');
    assert.match(
      dpa,
      /we do not represent that every downstream provider offers identical terms/i,
      'the DPA must say what it cannot guarantee, not imply it can',
    );
  });

  it('keeps the automated-decision position consistent with the Terms carve-out', () => {
    assert.match(dpa, /sanctions screening/i);
    assert.match(visible(read('docs/terms.mdx')), /sanctions screening/i);
  });
});

describe('the DPA is obtainable', () => {
  it('applies without a signature', () => {
    assert.match(dpa, /You do not need to sign anything for this DPA to apply/i);
    assert.match(dpa, /countersigned copy/i, 'procurement that needs a signed copy must be told how to get one');
  });

  it('gives a data protection contact', () => {
    assert.match(dpa, /privacy@worldmonitor\.app/);
  });

  it('is reachable from the documents a customer starts at', () => {
    for (const [label, path] of [
      ['Terms', 'docs/terms.mdx'],
      ['EULA', 'docs/eula.mdx'],
      ['Privacy Policy', 'docs/privacy.mdx'],
    ]) {
      assert.match(visible(read(path)), /\(\/dpa\)/, `${label} must link the DPA`);
    }
    for (const [label, path] of [
      ['Terms (zh)', 'docs/zh/terms.mdx'],
      ['EULA (zh)', 'docs/zh/eula.mdx'],
      ['Privacy Policy (zh)', 'docs/zh/privacy.mdx'],
    ]) {
      assert.match(visible(read(path)), /\(\/zh\/dpa\)/, `${label} must link the DPA`);
    }
  });

  it('states the transfer mechanism a European buyer will look for', () => {
    assert.match(dpa, /standard contractual clauses/i);
    assert.match(dpa, /Module Two/);
    assert.match(dpa, /UK Addendum/i);
    assert.match(dpa, /72 hours/, 'breach notification timing is the second thing they check');
  });
});
