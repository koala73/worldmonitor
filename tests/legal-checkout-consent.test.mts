/**
 * Pre-payment assent on every checkout entry point (#6976).
 *
 * Checkout redirects top-level to Dodo's hosted page. Dodo is merchant of
 * record and shows *its* terms there, so unless ours are presented before the
 * click they are presented nowhere in the purchase path — and the clauses we
 * depend on (per-plan license scope, the USD 100 / 12-month liability cap, the
 * Dubai venue) are the first to be struck when assent is absent.
 *
 * The load-bearing case here is `every dashboard CTA that starts a checkout
 * renders the assent line`. It derives its population by scanning `src/` for
 * real `startCheckout(` call sites rather than listing the surfaces it knows
 * about, so a NEW upgrade button fails this suite instead of shipping silently.
 * The exceptions are the funnels with no CTA of their own, each named with the
 * reason it renders no line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  CHECKOUT_CONSENT_TEXT,
  EULA_PATH,
  PRIVACY_PATH,
} from '../shared/legal.ts';
import { checkoutConsentHtml } from '../src/utils/legal-links.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'src');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ORIGIN = 'https://worldmonitor.app';

/**
 * Call sites only. A bare `startCheckout` substring also matches the dozen
 * doc-comments that discuss the funnel, and counting those would force assent
 * lines onto files that render nothing.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, found);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(abs);
  }
  return found;
}

/**
 * Files that start a checkout but render no CTA of their own. Each entry is an
 * assertion about the code, re-checked below: none of them may contain CTA
 * markup, so this list cannot quietly become a way to opt a real button out.
 */
const NO_CTA_OF_ITS_OWN: Record<string, string> = {
  'src/services/checkout.ts':
    'the funnel itself — every CTA below routes through it',
  'src/components/checkout-failure-banner.ts':
    'retry of a checkout the user already consented to on the CTA that started it',
  'src/utils/follow-button.ts':
    'a programmatic upgrade trigger; the CTA markup belongs to its callers',
};

const CONSENT_RENDERERS = ['checkoutConsentHtml(', 'createCheckoutConsentElement('];
/** Markup that means "this file paints an upgrade button". */
const CTA_MARKERS = ['panel-locked-cta', 'upgrade-pro-cta', 're-content__upgrade', 'gate-btn'];

const checkoutCallers = walk(SRC)
  .filter(abs => /(?:^|[.\s(])startCheckout\(/.test(stripComments(readFileSync(abs, 'utf8'))))
  .map(abs => relative(ROOT, abs).split('\\').join('/'));

describe('checkout consent copy', () => {
  it('names the licence and the privacy policy, and reads as an agreement', () => {
    assert.equal(
      CHECKOUT_CONSENT_TEXT,
      'By subscribing you agree to the License Agreement and Privacy Policy.',
    );
  });

  it('the dashboard renderer links both documents absolutely', () => {
    const html = checkoutConsentHtml(ORIGIN);
    assert.ok(html.includes(`href="${ORIGIN}${EULA_PATH}"`), html);
    assert.ok(html.includes(`href="${ORIGIN}${PRIVACY_PATH}"`), html);
  });

  it('the dashboard renderer emits the same sentence as the shared constant', () => {
    const text = checkoutConsentHtml(ORIGIN).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(text, CHECKOUT_CONSENT_TEXT);
  });
});

describe('every checkout entry point presents the Terms first', () => {
  it('the scan found the dashboard checkout callers at all', () => {
    // A regex that silently matches nothing would make every case below vacuous.
    assert.ok(
      checkoutCallers.length >= 5,
      `expected several startCheckout() call sites in src/, found ${checkoutCallers.length}: ${checkoutCallers.join(', ')}`,
    );
    assert.ok(checkoutCallers.includes('src/components/Panel.ts'));
  });

  for (const file of checkoutCallers) {
    const exemptReason = NO_CTA_OF_ITS_OWN[file];

    if (exemptReason) {
      it(`${file} paints no CTA, so its exemption is honest (${exemptReason})`, () => {
        const source = read(file);
        for (const marker of CTA_MARKERS) {
          assert.ok(
            !source.includes(marker),
            `${file} is exempt from the assent line but renders CTA markup (${marker}) — wire the consent line instead of extending the exemption`,
          );
        }
      });
      continue;
    }

    it(`${file} renders the assent line above its CTA`, () => {
      const source = read(file);
      assert.ok(
        CONSENT_RENDERERS.some(fn => source.includes(fn)),
        `${file} starts a checkout but never renders the assent line. Add checkoutConsentHtml()/`
          + 'createCheckoutConsentElement(), or add it to NO_CTA_OF_ITS_OWN with a reason.',
      );
    });
  }
});

describe('/pro presents the Terms before payment', () => {
  it('the tier CTA renders the assent line immediately above the button', () => {
    const source = read('pro-test/src/components/PricingSection.tsx');
    assert.match(source, /import \{ CheckoutConsent \}/);
    const consentAt = source.indexOf('<CheckoutConsent />');
    const buttonAt = source.indexOf('<button\n      onClick={() => onCheckout(cta.productId)}');
    assert.ok(consentAt > 0, 'PricingSection must render <CheckoutConsent />');
    assert.ok(buttonAt > 0, 'PricingSection checkout button not found — update this anchor');
    assert.ok(consentAt < buttonAt, 'the assent line must precede the checkout button');
  });

  it('the /pro consent component links both documents', () => {
    const source = read('pro-test/src/components/CheckoutConsent.tsx');
    assert.match(source, /href=\{EULA_PATH\}/);
    assert.match(source, /href=\{PRIVACY_PATH\}/);
  });
});

describe('sign-up presents the licence too', () => {
  for (const file of [
    'src/services/clerk.ts',
    'pro-test/src/services/clerk.ts',
  ]) {
    it(`${file} passes Clerk the licence and Privacy page URLs`, () => {
      const source = read(file);
      assert.match(source, /termsPageUrl:/, `${file} must set appearance.layout.termsPageUrl`);
      assert.match(source, /privacyPageUrl:/, `${file} must set appearance.layout.privacyPageUrl`);
      assert.match(source, /EULA_PATH/, `${file} must use the shared EULA_PATH constant`);
    });
  }
});
