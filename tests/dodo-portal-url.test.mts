import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeDodoPortalRedirectUrl } from '../server/_shared/dodo-portal-url.ts';

describe('safeDodoPortalRedirectUrl', () => {
  it('accepts the customer portal host', () => {
    const url = 'https://customer.dodopayments.com/session/abc';
    assert.equal(safeDodoPortalRedirectUrl(url), url);
  });

  it('accepts a Dodo subdomain', () => {
    const url = 'https://test.customer.dodopayments.com/s/xyz';
    assert.equal(safeDodoPortalRedirectUrl(url), url);
  });

  it('keeps the query and fragment a session link may carry', () => {
    const url = 'https://customer.dodopayments.com/session/abc?lang=en#token=xyz';
    assert.equal(safeDodoPortalRedirectUrl(url), url);
  });

  it('rejects a trailing-dot host', () => {
    assert.equal(safeDodoPortalRedirectUrl('https://customer.dodopayments.com./s'), null);
  });

  it('rejects http', () => {
    assert.equal(safeDodoPortalRedirectUrl('http://customer.dodopayments.com/s'), null);
  });

  it('rejects a look-alike suffix host', () => {
    assert.equal(safeDodoPortalRedirectUrl('https://customer.dodopayments.com.evil.com/s'), null);
  });

  it('rejects credentials in the URL', () => {
    assert.equal(safeDodoPortalRedirectUrl('https://user:pass@customer.dodopayments.com/s'), null);
  });

  it('rejects a caller-supplied dashboard or open-redirect target', () => {
    assert.equal(safeDodoPortalRedirectUrl('https://evil.example/phish'), null);
    assert.equal(safeDodoPortalRedirectUrl('javascript:alert(1)'), null);
  });
});
