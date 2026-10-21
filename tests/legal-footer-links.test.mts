/**
 * The Terms are a browsewrap ("By using the Service, you agree to these
 * Terms") and a browsewrap is only as good as its link. #6976 found no Terms
 * or Privacy link in either production footer — the shared one on the welcome
 * and /pro pages, and the separate one the Enterprise page hand-rolls — and
 * none in the dashboard at all. (The issue calls the App.tsx footer "the /pro
 * pricing-page footer"; /pro actually renders the shared `<Footer />`, and that
 * second footer belongs to the `#enterprise` route. Both are covered.)
 *
 * This suite reads the PRERENDERED pages, not the JSX: `public/pro/*.html` is
 * what a buyer and a crawler actually receive, so a link that a refactor drops
 * from the render fails here even if the constant survives in source. The
 * dashboard's own legal row is built at runtime by `legalLinksHtml()`, which is
 * asserted directly.
 *
 * Built pages follow the repo convention (#6898): skip when the checkout has
 * not run `npm run build:pro`, FAIL when WM_EXPECT_BUILT_OUTPUT=1 says CI did.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EULA_PATH,
  LEGAL_FOOTER_LINKS,
  TERMS_PATH,
  PRIVACY_PATH,
  LICENSE_PATH,
  TRADEMARK_PATH,
} from '../shared/legal.ts';
import { legalLinksHtml } from '../src/utils/legal-links.ts';
// @ts-expect-error — JS helper, no declaration file
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

const skip = shouldSkipProBuiltOutput();
guardProBuiltOutput();

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** The rendered <footer> of a prerendered page. */
function footerOf(html: string, label: string): string {
  const match = html.match(/<footer[\s\S]*<\/footer>/);
  assert.ok(match, `${label} should render a <footer>`);
  return match[0];
}

const REQUIRED = [EULA_PATH, TERMS_PATH, PRIVACY_PATH, LICENSE_PATH, TRADEMARK_PATH];

describe('legal links are reachable in one click', () => {
  it('the shared cluster is every document a buyer is bound by', () => {
    assert.deepEqual(
      LEGAL_FOOTER_LINKS.map(link => link.path),
      REQUIRED,
    );
    for (const link of LEGAL_FOOTER_LINKS) {
      assert.ok(link.label.length > 0, `${link.path} needs a label`);
    }
  });

  it('the welcome page footer links every legal document', { skip }, () => {
    const footer = footerOf(read('public/pro/welcome.html'), 'the welcome page');
    for (const path of REQUIRED) {
      assert.ok(
        footer.includes(`href="${path}"`),
        `public/pro/welcome.html footer is missing href="${path}"`,
      );
    }
  });

  /**
   * Only welcome.html is prerendered — `pro-test/prerender.mjs` renders
   * index.html with empty content, so the Enterprise footer exists only after
   * hydration and no built artifact can be read for it. Rather than assert a
   * second hand-written row by regex, both footers render the SAME component,
   * whose anchors the prerender case above proves for real. What is left to
   * check here is only that this footer still mounts it.
   *
   * /pro itself needs no separate case: it renders the shared `<Footer />`,
   * the same component welcome.html prerenders. Verified in a browser at
   * /pro/#pricing, /pro/#enterprise, and /pro/welcome.html.
   */
  it('the Enterprise page footer mounts the same legal nav', () => {
    const app = read('pro-test/src/App.tsx');
    const footer = footerOf(app, 'pro-test/src/App.tsx');
    assert.match(
      footer,
      /<LegalFooterNav\s*\/>/,
      'the Enterprise footer must render <LegalFooterNav />, not a copy of the links',
    );
    assert.match(app, /import \{ LegalFooterNav \}/);
  });

  it('the shared footer (welcome + /pro) mounts the same legal nav', () => {
    const footer = footerOf(read('pro-test/src/components/Footer.tsx'), 'Footer.tsx');
    assert.match(footer, /<LegalFooterNav\s*\/>/);
  });

  it('the dashboard legal row carries the same four documents', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    for (const path of REQUIRED) {
      assert.ok(
        html.includes(`href="https://worldmonitor.app${path}"`),
        `dashboard legal row is missing ${path}`,
      );
    }
  });

  it('the dashboard legal row is absolute, so the desktop WebView resolves it', () => {
    // A root-relative /docs/terms inside Tauri resolves against the bundled
    // app origin and 404s — the one runtime where the link silently dies.
    const html = legalLinksHtml('https://worldmonitor.app');
    assert.ok(!/href="\/docs\//.test(html), 'legal row must not emit root-relative doc links');
  });

  it('the dashboard legal row opens externally without leaking the opener', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    assert.equal(anchors.length, REQUIRED.length);
    for (const anchor of anchors) {
      assert.match(anchor, /rel="noopener noreferrer"/, `missing rel on ${anchor}`);
      assert.match(anchor, /target="_blank"/, `missing target on ${anchor}`);
    }
  });
});
