/**
 * Open-redirect guard for Dodo redirect-mode checkout (#4449).
 *
 * `safeHostedCheckoutUrl` gates the `window.location.assign` in redirect mode,
 * so its rejection branches are security-critical: a server response that ever
 * carried an unexpected origin, an http downgrade, a `javascript:` URL, or a
 * non-string must NOT navigate the buyer anywhere. Only Dodo's two hosted
 * checkout origins over HTTPS are allowed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeHostedCheckoutUrl } from '../src/services/hosted-checkout-url.ts';

describe('safeHostedCheckoutUrl', () => {
  it('accepts the production hosted-checkout origin', () => {
    const url = 'https://checkout.dodopayments.com/session/cks_abcdefghijklmnopqrstuv';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  it('accepts the test hosted-checkout origin', () => {
    const url = 'https://test.checkout.dodopayments.com/session/cks_abcdefghijklmnopqrstuv';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  it('accepts a plain payment-link path on the hosted origin', () => {
    const url = 'https://checkout.dodopayments.com/Z3okzwYA';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  it('rejects a non-HTTPS (http) downgrade on the hosted origin', () => {
    assert.equal(safeHostedCheckoutUrl('http://checkout.dodopayments.com/session/cks_x'), null);
  });

  it('rejects a third-party host', () => {
    assert.equal(safeHostedCheckoutUrl('https://evil.com/session/cks_x'), null);
  });

  it('rejects a look-alike suffix host (dodopayments.com.evil.com)', () => {
    assert.equal(safeHostedCheckoutUrl('https://checkout.dodopayments.com.evil.com/x'), null);
  });

  it('rejects an unlisted subdomain of the checkout domain', () => {
    assert.equal(safeHostedCheckoutUrl('https://evil.checkout.dodopayments.com/x'), null);
  });

  it('rejects a javascript: URL', () => {
    assert.equal(safeHostedCheckoutUrl('javascript:alert(1)'), null);
  });

  it('rejects an unparseable / non-URL string', () => {
    assert.equal(safeHostedCheckoutUrl('not a url'), null);
    assert.equal(safeHostedCheckoutUrl(''), null);
  });

  it('rejects non-string inputs', () => {
    assert.equal(safeHostedCheckoutUrl(null), null);
    assert.equal(safeHostedCheckoutUrl(undefined), null);
    assert.equal(safeHostedCheckoutUrl(42), null);
    assert.equal(safeHostedCheckoutUrl({ toString: () => 'https://checkout.dodopayments.com/x' }), null);
  });
});
