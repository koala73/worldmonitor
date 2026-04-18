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

// REGRESSION: PR #3175 P1 — share codes didn't resolve to a sharer.
// The earlier head generated 8-char Clerk HMAC codes but the waitlist
// register mutation only looked up `registrations.by_referral_code`
// (6-char email codes). Codes from the share button never credited
// anyone. These tests lock the attribution path into the codebase.
describe('referral attribution resolves Clerk codes (waitlist path)', () => {
  it('convex/registerInterest.ts extends register to look up userReferralCodes when registrations miss', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__d, '../convex/registerInterest.ts'), 'utf-8');
    // Must still credit the registrations-path referrer first.
    assert.match(src, /referralCount:\s*\(registrationReferrer\.referralCount\s*\?\?\s*0\)\s*\+\s*1/);
    // Must fall through to the userReferralCodes lookup when no
    // registrations row matches (the actual fix).
    assert.match(src, /\.query\("userReferralCodes"\)[\s\S]+?\.withIndex\("by_code"/);
    // Must insert a credit row, not try to increment a non-existent
    // registrations.referralCount for the Clerk user.
    assert.match(src, /ctx\.db\.insert\("userReferralCredits"/);
    // Must dedupe by (referrer, refereeEmail) so returning visitors
    // re-submitting the waitlist don't double-credit.
    assert.match(src, /by_referrer_email/);
  });

  it('convex/schema.ts declares userReferralCodes + userReferralCredits with the right indexes', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__d, '../convex/schema.ts'), 'utf-8');
    assert.match(src, /userReferralCodes:\s*defineTable/);
    assert.match(src, /userReferralCredits:\s*defineTable/);
    assert.match(src, /\.index\("by_code",\s*\["code"\]\)/);
    assert.match(src, /\.index\("by_referrer_email",\s*\["referrerUserId",\s*"refereeEmail"\]\)/);
  });

  it('/api/referral/me fires the Convex binding non-blocking and never 503s on binding failure', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__d, '../api/referral/me.ts'), 'utf-8');
    assert.match(src, /registerReferralCodeInConvex/, 'helper must exist');
    // CURRENT CONTRACT: binding is fire-and-forget via ctx.waitUntil.
    //
    // An earlier iteration (the "await + 503 on failure" shape this
    // test used to enforce) turned a flaky Convex relay call into a
    // homepage-wide 503 for every PRO user — the homepage fetches
    // this endpoint on mount, so one bad Convex response broke the
    // 5-minute cache window for everyone. The mutation is idempotent
    // and the /pro?ref=<code> signup side re-reads at conversion
    // time, so a missed binding degrades to missed attribution
    // rather than outright breakage.
    assert.match(
      src,
      /ctx\.waitUntil\(\s*registerReferralCodeInConvex/,
      'binding must be dispatched via ctx.waitUntil (non-blocking)',
    );
    // Handler must accept a second ctx arg with waitUntil — matches
    // the notification-channels + discord-oauth handler shapes.
    assert.match(
      src,
      /export\s+default\s+async\s+function\s+handler\s*\(\s*req:\s*Request,\s*ctx:\s*\{\s*waitUntil:/,
      'handler signature must take ctx with waitUntil',
    );
    // MUST NOT 503 on a binding failure — the whole point of the
    // non-blocking shape. Handler must not mention "binding failed"
    // anywhere near a 503 response code.
    assert.doesNotMatch(
      src,
      /binding failed[\s\S]{0,200}service_unavailable[\s\S]{0,50}503/,
      'binding failure must not return 503',
    );
    // BRIEF_URL_SIGNING_SECRET missing still legitimately 503s
    // (different codepath; we can't mint a code without the secret).
    // That's intentional, and unrelated to the Convex binding.
    assert.match(
      src,
      /BRIEF_URL_SIGNING_SECRET is not configured[\s\S]{0,200}503/,
      'missing signing secret still 503s',
    );
    assert.match(src, /\/relay\/register-referral-code/, 'must POST to the Convex HTTP action');
  });

  it('subscriptionHelpers credits the sharer on the /pro?ref= checkout path via metadata.affonso_referral', async () => {
    // REGRESSION: the earlier head only wired the waitlist path
    // (/api/register-interest), so anyone who landed on /pro?ref=
    // and went straight to Dodo checkout never credited the sharer.
    // The webhook now reads metadata.affonso_referral on
    // subscription.active, resolves it to a userId via
    // userReferralCodes, and inserts a userReferralCredits row.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__d, '../convex/payments/subscriptionHelpers.ts'), 'utf-8');
    assert.match(src, /affonso_referral/, 'webhook must read the Dodo referral metadata key');
    assert.match(src, /\.query\("userReferralCodes"\)[\s\S]+?\.withIndex\("by_code"/, 'webhook must resolve the code to a userId');
    assert.match(src, /ctx\.db\.insert\("userReferralCredits"/, 'webhook must insert a credit row on conversion');
    // Double-credit guard: the credit insertion must be gated by a
    // by_referrer_email existence check so replay webhooks don't
    // create duplicate rows for the same (referrer, referee) pair.
    assert.match(src, /by_referrer_email[\s\S]+?ctx\.db\.insert\("userReferralCredits"/, 'credit insertion must dedupe by (referrer, email)');
  });
});
