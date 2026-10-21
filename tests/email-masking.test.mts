/**
 * Locks the masking shape for the post-checkout success banner.
 * The banner is shown at the top of the viewport during the webhook-
 * propagation window, so the address can end up in screenshots,
 * screen-shares, or phone photos. Masking is what prevents "PII
 * casually leaking to an arbitrary observer."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { maskEmail } from '../src/services/checkout-banner-state.ts';

describe('maskEmail', () => {
  it('masks a typical address as first-char + *** + @domain', () => {
    assert.equal(maskEmail('elie@anghami.com'), 'e***@anghami.com');
  });

  it('handles a single-letter local part safely', () => {
    assert.equal(maskEmail('a@example.com'), 'a***@example.com');
  });

  it('preserves plus-addressing in the domain half (nothing leaks local detail)', () => {
    // Plus-addressing lives in the local part which is masked entirely,
    // so the `+tag` token is dropped — that's the desired privacy.
    assert.equal(maskEmail('user+promos@example.com'), 'u***@example.com');
  });

  it('preserves dots in the local part by masking everything after the first char', () => {
    assert.equal(maskEmail('first.last@example.com'), 'f***@example.com');
  });

  it('preserves a long domain unchanged', () => {
    assert.equal(maskEmail('u@mail.subdomain.example.co.uk'), 'u***@mail.subdomain.example.co.uk');
  });

  it('trims surrounding whitespace before masking', () => {
    assert.equal(maskEmail('  elie@anghami.com  '), 'e***@anghami.com');
  });

  it('handles IDN-style domains by pass-through', () => {
    assert.equal(maskEmail('u@bücher.example'), 'u***@bücher.example');
  });

  it('returns null for undefined input', () => {
    assert.equal(maskEmail(undefined), null);
  });

  it('returns null for null input', () => {
    assert.equal(maskEmail(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(maskEmail(''), null);
  });

  it('returns null when @ is missing', () => {
    assert.equal(maskEmail('not-an-email'), null);
  });

  it('returns null when local part is empty (leading @)', () => {
    assert.equal(maskEmail('@example.com'), null);
  });

  it('returns null when domain part is empty (trailing @)', () => {
    assert.equal(maskEmail('user@'), null);
  });

  it('returns null for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(maskEmail(1234 as any), null);
  });

  it('never returns a string containing the original local part beyond the first char', () => {
    const sensitive = 'bob.secret.identity@example.com';
    const masked = maskEmail(sensitive);
    assert.ok(masked !== null);
    // The masked form should NOT contain "bob.secret" or "secret.identity".
    assert.ok(!masked.includes('bob.secret'));
    assert.ok(!masked.includes('secret'));
    assert.ok(!masked.includes('identity'));
  });
});
