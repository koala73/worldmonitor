/**
 * Desktop checkout handoff account binding (#10342).
 *
 * A desktop "Upgrade to Pro" click hands the user to /pro in the OS browser,
 * where checkout runs on the BROWSER's session. The handoff URL therefore
 * carries a fingerprint of the desktop account so /pro can refuse to charge a
 * different one. The fingerprint is a truncated SHA-256 of the Clerk user id:
 * stable across both builds, and it keeps the raw id out of URLs, analytics
 * and server logs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECKOUT_ACCOUNT_PARAM,
  buildAttributedProUrl,
  fingerprintCheckoutAccount,
  parseCheckoutAccountFingerprint,
} from '../shared/checkout-attribution.ts';

describe('fingerprintCheckoutAccount', () => {
  it('is deterministic, 16 lowercase hex chars, and not the user id', async () => {
    const a = await fingerprintCheckoutAccount('user_2abcDEF');
    const b = await fingerprintCheckoutAccount('user_2abcDEF');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.ok(!a.includes('user_'));
  });

  it('separates accounts that differ by one character', async () => {
    assert.notEqual(
      await fingerprintCheckoutAccount('user_2abcDEF'),
      await fingerprintCheckoutAccount('user_2abcDEG'),
    );
  });

  it('matches the SHA-256 prefix so both builds agree without sharing code paths', async () => {
    // sha256("user_1") = 79b0…; pinned so a hash swap in one build cannot go unnoticed.
    assert.equal(await fingerprintCheckoutAccount('user_1'), '79b0aa0042b3c056');
  });
});

describe('parseCheckoutAccountFingerprint', () => {
  it('accepts only a well-formed fingerprint', () => {
    assert.equal(parseCheckoutAccountFingerprint(`?${CHECKOUT_ACCOUNT_PARAM}=79b0aa0042b3c056`), '79b0aa0042b3c056');
    assert.equal(parseCheckoutAccountFingerprint(`?${CHECKOUT_ACCOUNT_PARAM}=79B0AA0042B3C056`), null);
    assert.equal(parseCheckoutAccountFingerprint(`?${CHECKOUT_ACCOUNT_PARAM}=79b0aa00`), null);
    assert.equal(parseCheckoutAccountFingerprint(`?${CHECKOUT_ACCOUNT_PARAM}=user_1`), null);
    assert.equal(parseCheckoutAccountFingerprint('?wm_checkout_handoff=desktop'), null);
    assert.equal(parseCheckoutAccountFingerprint(''), null);
  });
});

describe('buildAttributedProUrl account binding', () => {
  it('stamps the fingerprint only alongside the desktop handoff', () => {
    const bound = new URL(buildAttributedProUrl('https://worldmonitor.app/pro#pricing', undefined, {
      desktopHandoff: true,
      accountFingerprint: '79b0aa0042b3c056',
    }));
    assert.equal(bound.searchParams.get('wm_checkout_handoff'), 'desktop');
    assert.equal(bound.searchParams.get(CHECKOUT_ACCOUNT_PARAM), '79b0aa0042b3c056');
    assert.equal(bound.hash, '#pricing');

    // A fingerprint without the handoff has no consumer: never leak it onto web URLs.
    const web = new URL(buildAttributedProUrl('https://worldmonitor.app/pro', undefined, {
      accountFingerprint: '79b0aa0042b3c056',
    }));
    assert.equal(web.searchParams.has(CHECKOUT_ACCOUNT_PARAM), false);

    // A malformed value is dropped rather than forwarded.
    const bad = new URL(buildAttributedProUrl('https://worldmonitor.app/pro', undefined, {
      desktopHandoff: true,
      accountFingerprint: 'user_1',
    }));
    assert.equal(bad.searchParams.has(CHECKOUT_ACCOUNT_PARAM), false);
    assert.equal(bad.searchParams.get('wm_checkout_handoff'), 'desktop');
  });
});
