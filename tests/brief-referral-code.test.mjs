// Phase 9 / Todo #223 — deterministic referral code + share URL.
//
// Locks the two pure helpers:
//   - getReferralCodeForUser(userId, secret) is stable per (userId, secret)
//   - buildShareUrl(base, code) produces the expected /pro?ref= URL
//     shape the landing page's reading code already understands.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getReferralCodeForUser,
  buildShareUrl,
} from '../server/_shared/referral-code.ts';

const SECRET = 'test-secret-change-me';

describe('getReferralCodeForUser', () => {
  it('produces an 8-char hex code for a Clerk userId', async () => {
    const code = await getReferralCodeForUser('user_2abc123def', SECRET);
    assert.match(code, /^[0-9a-f]{8}$/);
  });

  it('is deterministic: same inputs → same code', async () => {
    const a = await getReferralCodeForUser('user_abc', SECRET);
    const b = await getReferralCodeForUser('user_abc', SECRET);
    assert.equal(a, b);
  });

  it('is unique across different userIds', async () => {
    const a = await getReferralCodeForUser('user_alice', SECRET);
    const b = await getReferralCodeForUser('user_bob', SECRET);
    assert.notEqual(a, b);
  });

  it('changes when the secret rotates (rotation invalidates old codes)', async () => {
    const a = await getReferralCodeForUser('user_abc', SECRET);
    const b = await getReferralCodeForUser('user_abc', 'different-secret');
    assert.notEqual(a, b);
  });

  it('rejects empty userId', async () => {
    await assert.rejects(() => getReferralCodeForUser('', SECRET), /invalid_user_id/);
  });

  it('rejects missing secret', async () => {
    await assert.rejects(() => getReferralCodeForUser('user_abc', ''), /missing_secret/);
  });
});

describe('buildShareUrl', () => {
  it('appends /pro?ref={code} to the base URL', () => {
    assert.equal(
      buildShareUrl('https://worldmonitor.app', 'abc12345'),
      'https://worldmonitor.app/pro?ref=abc12345',
    );
  });

  it('trims a trailing slash on the base URL', () => {
    assert.equal(
      buildShareUrl('https://worldmonitor.app/', 'abc12345'),
      'https://worldmonitor.app/pro?ref=abc12345',
    );
  });

  it('trims multiple trailing slashes', () => {
    assert.equal(
      buildShareUrl('https://worldmonitor.app////', 'abc12345'),
      'https://worldmonitor.app/pro?ref=abc12345',
    );
  });

  it('URL-encodes the code (defensive — code is always hex in practice)', () => {
    assert.equal(
      buildShareUrl('https://worldmonitor.app', 'a b'),
      'https://worldmonitor.app/pro?ref=a%20b',
    );
  });
});
