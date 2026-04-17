// HMAC-signed brief URL helpers.
//
// The signed token is the credential for the hosted magazine route —
// a recipient with the URL can read the brief, no other auth. These
// tests lock down the invariants that matter: deterministic signing,
// rejection of tampered inputs, and graceful rotation via a second
// accepted secret during overlap windows.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BriefUrlError,
  signBriefToken,
  signBriefUrl,
  verifyBriefToken,
} from '../server/_shared/brief-url.ts';

const SECRET = 'primary-secret-for-tests-0123456789';
const PREV_SECRET = 'rotated-out-legacy-secret-abcdefghij';
const USER_ID = 'user_abc123';
const ISSUE_DATE = '2026-04-17';

describe('signBriefToken + verifyBriefToken', () => {
  it('round-trips: verify(sign) is true for matching inputs', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(await verifyBriefToken(USER_ID, ISSUE_DATE, token, SECRET), true);
  });

  it('produces a 43-char base64url token (SHA-256 without padding)', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    const b = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(a, b);
  });

  it('rejects a tampered token', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    // Flip one base64url char without changing shape.
    const tampered = token.startsWith('A')
      ? `B${token.slice(1)}`
      : `A${token.slice(1)}`;
    assert.equal(await verifyBriefToken(USER_ID, ISSUE_DATE, tampered, SECRET), false);
  });

  it('rejects a token bound to a different userId', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(await verifyBriefToken('user_xyz', ISSUE_DATE, token, SECRET), false);
  });

  it('rejects a token bound to a different issueDate', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(await verifyBriefToken(USER_ID, '2026-04-18', token, SECRET), false);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, 'other-secret');
    assert.equal(await verifyBriefToken(USER_ID, ISSUE_DATE, token, SECRET), false);
  });

  it('rejects a malformed token shape without touching crypto', async () => {
    // Tokens of the wrong length short-circuit.
    assert.equal(await verifyBriefToken(USER_ID, ISSUE_DATE, 'too-short', SECRET), false);
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, 'a'.repeat(44), SECRET),
      false,
    );
    // Non-string token.
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, /** @type {any} */ (null), SECRET),
      false,
    );
  });

  it('rejects a malformed userId or issueDate on verify without throwing', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(await verifyBriefToken('', ISSUE_DATE, token, SECRET), false);
    assert.equal(await verifyBriefToken('user with spaces', ISSUE_DATE, token, SECRET), false);
    assert.equal(await verifyBriefToken(USER_ID, '04/17/2026', token, SECRET), false);
  });

  it('throws BriefUrlError when signing with an empty secret', async () => {
    await assert.rejects(
      () => signBriefToken(USER_ID, ISSUE_DATE, ''),
      (err) => err instanceof BriefUrlError && err.code === 'missing_secret',
    );
  });

  it('throws BriefUrlError when verifying with an empty secret', async () => {
    const token = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    await assert.rejects(
      () => verifyBriefToken(USER_ID, ISSUE_DATE, token, ''),
      (err) => err instanceof BriefUrlError && err.code === 'missing_secret',
    );
  });

  it('throws BriefUrlError on malformed userId at sign time', async () => {
    await assert.rejects(
      () => signBriefToken('user with spaces', ISSUE_DATE, SECRET),
      (err) => err instanceof BriefUrlError && err.code === 'invalid_user_id',
    );
  });

  it('throws BriefUrlError on malformed issueDate at sign time', async () => {
    await assert.rejects(
      () => signBriefToken(USER_ID, '2026/04/17', SECRET),
      (err) => err instanceof BriefUrlError && err.code === 'invalid_issue_date',
    );
  });
});

describe('secret rotation', () => {
  it('accepts tokens signed with the previous secret during rotation', async () => {
    const legacyToken = await signBriefToken(USER_ID, ISSUE_DATE, PREV_SECRET);
    // Primary is rotated; prev is still accepted during the overlap.
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, legacyToken, SECRET, PREV_SECRET),
      true,
    );
  });

  it('still accepts tokens signed with the new primary after rotation', async () => {
    const freshToken = await signBriefToken(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, freshToken, SECRET, PREV_SECRET),
      true,
    );
  });

  it('rejects a token signed with a third, unknown secret even when prev is set', async () => {
    const strayToken = await signBriefToken(USER_ID, ISSUE_DATE, 'unknown-secret');
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, strayToken, SECRET, PREV_SECRET),
      false,
    );
  });

  it('rejects previous-secret tokens once prev is removed', async () => {
    const legacyToken = await signBriefToken(USER_ID, ISSUE_DATE, PREV_SECRET);
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, legacyToken, SECRET),
      false,
    );
  });
});

describe('signBriefUrl', () => {
  it('composes a URL with the expected path and token', async () => {
    const url = await signBriefUrl({
      userId: USER_ID,
      issueDate: ISSUE_DATE,
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET,
    });
    assert.match(
      url,
      new RegExp(`^https://worldmonitor\\.app/api/brief/${USER_ID}/${ISSUE_DATE}\\?t=[A-Za-z0-9_-]{43}$`),
    );
  });

  it('trims trailing slash on baseUrl', async () => {
    const url = await signBriefUrl({
      userId: USER_ID,
      issueDate: ISSUE_DATE,
      baseUrl: 'https://worldmonitor.app/',
      secret: SECRET,
    });
    assert.ok(url.startsWith('https://worldmonitor.app/api/brief/'));
    assert.ok(!url.includes('.app//api/'));
  });

  it('URL-encodes the path components', async () => {
    // Underscore + dash are legal userId chars; they must NOT be
    // percent-encoded by the helper (encodeURIComponent preserves
    // them), which keeps the URL readable in email clients.
    const url = await signBriefUrl({
      userId: 'user_abc-123',
      issueDate: ISSUE_DATE,
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET,
    });
    assert.ok(url.includes('/brief/user_abc-123/'));
  });
});
