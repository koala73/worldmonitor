/**
 * A pricing card must state how many people the plan covers (#5726).
 *
 * Pro and Pro Business are one seat each, and neither card said so. Adjacent
 * copy invited "teams" — the axis header over that column, and the "Best for"
 * line on the agent-facing sheet. Since #6982/#6983 the buyer also *accepts*
 * the EULA at the checkout button, and EULA §4.1 says Pro Business is "One
 * named subscriber" and excludes "Shared login access". So the card and the
 * licence the same click binds you to disagreed.
 *
 * The invariant here is the pairing, not the wording: while the licence says a
 * tier is single-seat, every surface that sells it has to say so too. Change
 * the product to multi-seat (#6636) and this fails until the licence moves
 * with it — which is the point.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** States a count of people, in any of the forms the copy actually uses. */
const SEAT_STATEMENT = /\b(\d+)\s+(named users?|licensed users?|Pro licenses?|seats?)\b/i;

/**
 * Tiers the EULA describes with a seat count, and the count it states.
 * Sourced from docs/eula.mdx §4.1 — asserted below rather than trusted.
 */
const SEATED_TIERS = [
  { planKey: 'pro_monthly', localeKey: 'pro', seats: 1, eula: /Personal license \(Pro\)[\s\S]*?One named subscriber/ },
  { planKey: 'pro_business_monthly', localeKey: 'proBusiness', seats: 1, eula: /Commercial license \(Pro Business\)[\s\S]*?One named subscriber/ },
  { planKey: 'api_business', localeKey: 'apiBusiness', seats: 5, eula: /five included Pro Business seats/ },
];

function catalogCopy(planKey: string): string {
  const entry = Object.values(PRODUCT_CATALOG).find((tier: { planKey?: string }) => tier.planKey === planKey) as
    | { marketingFeatures?: string[]; highlightFeatures?: string[] }
    | undefined;
  assert.ok(entry, `${planKey} is not in PRODUCT_CATALOG — this test names a tier that no longer exists`);
  return [...(entry.marketingFeatures ?? []), ...(entry.highlightFeatures ?? [])].join(' | ');
}

describe('a seated plan says how many seats it has', () => {
  const eula = read('docs/eula.mdx');
  const en = JSON.parse(read('pro-test/src/locales/en.json'));

  for (const { planKey, localeKey, seats, eula: eulaPattern } of SEATED_TIERS) {
    it(`the EULA still states the seat count for ${planKey}`, () => {
      // The anchor. If the licence stops saying this, the assertions below are
      // enforcing a rule that no longer exists and must be re-derived.
      assert.match(eula, eulaPattern, `docs/eula.mdx no longer describes ${planKey} the way this test assumes`);
    });

    it(`the catalog copy for ${planKey} states ${seats}`, () => {
      const copy = catalogCopy(planKey);
      const match = copy.match(SEAT_STATEMENT);
      assert.ok(match, `${planKey} sells without stating a seat count: ${copy}`);
      assert.equal(Number(match[1]), seats, `${planKey} states ${match[1]} seats, licence says ${seats}`);
    });

    it(`the /pro card copy for ${localeKey} states ${seats}`, () => {
      // Locale features override the catalog at render time
      // (PricingSection.localizeTier), so the catalog alone proves nothing
      // about what a buyer sees.
      const tier = en.pricing.tiers[localeKey];
      assert.ok(tier, `pricing.tiers.${localeKey} missing from en.json`);
      const copy = [...(tier.features ?? []), ...(tier.highlightFeatures ?? [])].join(' | ');
      const match = copy.match(SEAT_STATEMENT);
      assert.ok(match, `the ${localeKey} card sells without stating a seat count: ${copy}`);
      assert.equal(Number(match[1]), seats, `${localeKey} card states ${match[1]} seats, licence says ${seats}`);
    });
  }

  it('no single-seat tier is sold under plural-user copy', () => {
    // "teams" over a column whose first card is one seat is the invitation
    // #5726 was filed about. Narrow on purpose: this is not a style rule, it
    // is the specific phrase that contradicted the licence.
    assert.doesNotMatch(
      en.pricing.axisCommercialNote,
      /\bteams?\b/i,
      'the commercial axis spans Pro Business, which is one seat — "teams" invites the breach',
    );

    const sheet = read('public/pricing.md');
    const proBusinessBlock = sheet.slice(sheet.indexOf('## Pro Business'), sheet.indexOf('## API Starter'));
    assert.doesNotMatch(
      proBusinessBlock,
      /\bteams\b/i,
      'public/pricing.md still sells Pro Business to "teams"',
    );
    assert.match(proBusinessBlock, SEAT_STATEMENT, 'public/pricing.md must state the Pro Business seat count');
  });

  it('the human pricing page states both single-seat counts', () => {
    const pricing = read('docs/pricing.mdx');
    const proRow = pricing.split('\n').find((line) => line.startsWith('| **Pro** |'));
    const proBusinessRow = pricing.split('\n').find((line) => line.startsWith('| **Pro Business** |'));
    assert.ok(proRow && proBusinessRow, 'pricing table rows not found — update this anchor');
    assert.match(proRow, SEAT_STATEMENT);
    assert.match(proBusinessRow, SEAT_STATEMENT);
  });
});
