/**
 * The legal documents are only as strong as the place a user can find them.
 *
 * Before #6976 neither production footer linked the Terms, the Privacy Policy,
 * or the licence: the only route from /pro to the Terms was one FAQ answer.
 * A browsewrap whose link is invisible is the weakest form of assent there is,
 * and the clauses that depend on it are the plan scopes, the seat rules, and
 * the liability cap.
 *
 * This guards the link, not the styling — a redesign may move the footer, but
 * it may not drop these three hrefs, and it may not point them at a docs page
 * that does not exist.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

const REQUIRED_LEGAL_LINKS = [
  { href: 'https://www.worldmonitor.app/docs/eula', page: 'docs/eula.mdx' },
  { href: 'https://www.worldmonitor.app/docs/terms', page: 'docs/terms.mdx' },
  { href: 'https://www.worldmonitor.app/docs/privacy', page: 'docs/privacy.mdx' },
];

// Both footers are shipped: Footer.tsx renders on the welcome page, and App.tsx
// carries its own copy on the pricing page. A link added to one only is a gap.
const FOOTER_SOURCES = [
  'pro-test/src/components/Footer.tsx',
  'pro-test/src/App.tsx',
];

function footerRegions(text) {
  const regions = [...text.matchAll(/<footer[\s\S]*?<\/footer>/g)].map((match) => match[0]);
  assert.ok(regions.length > 0, 'expected at least one <footer> element');
  return regions;
}

describe('legal links reach every published footer', () => {
  for (const relativePath of FOOTER_SOURCES) {
    for (const { href } of REQUIRED_LEGAL_LINKS) {
      it(`${relativePath} links ${href}`, () => {
        const text = readFileSync(join(root, relativePath), 'utf8');
        const inFooter = footerRegions(text).some((region) => region.includes(`href="${href}"`));
        assert.ok(
          inFooter,
          `${relativePath} must link ${href} from inside its <footer> (see #6976)`,
        );
      });
    }
  }

  for (const { href, page } of REQUIRED_LEGAL_LINKS) {
    it(`${href} resolves to a published page`, () => {
      assert.ok(existsSync(join(root, page)), `${href} points at missing ${page}`);
    });
  }

  it('the EULA is reachable from the Terms and the pricing page too', () => {
    const terms = readFileSync(join(root, 'docs/terms.mdx'), 'utf8');
    const pricing = readFileSync(join(root, 'docs/pricing.mdx'), 'utf8');

    assert.match(terms, /\(\/eula\)/, 'Terms must link the EULA');
    assert.match(pricing, /\(\/eula\)/, 'the pricing page must link the EULA');
  });
});
