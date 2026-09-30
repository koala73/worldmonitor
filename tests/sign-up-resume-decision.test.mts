/**
 * The resume predicate over the sign-up attempt Clerk hands back after a
 * reload (#8577). The fixture is the production `clerk.client.signUp` captured
 * on 2026-09-26: the attempt survives the reload with the same id, an
 * unverified `email_code` verification and Clerk's own two deadlines.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODE_EXPIRY_MARGIN_MS,
  asEpochMs,
  asSignUpAttemptId,
  decideResume,
  readSignUpSnapshot,
  type ClerkSignUp,
  type ResumeInput,
  type SignUpSnapshot,
} from '../src/services/sign-up-resume.ts';

const NOW = 1_790_400_000_000;
const ATTEMPT_ID = 'sua_3Jr2uAz4iuUohdPDXnaKu9y6N6Y';
const EMAIL = 'new-user@example.com';
const CODE_EXPIRES_AT = NOW + 10 * 60_000;
const ABANDON_AT = NOW + 24 * 3_600_000;

function capturedSignUp(overrides: Record<string, unknown> = {}): ClerkSignUp {
  return {
    id: ATTEMPT_ID,
    status: 'missing_requirements',
    missingFields: [],
    requiredFields: ['email_address'],
    unverifiedFields: ['email_address'],
    emailAddress: EMAIL,
    verifications: {
      emailAddress: {
        status: 'unverified',
        strategy: 'email_code',
        attempts: 1,
        expireAt: new Date(CODE_EXPIRES_AT),
      },
    },
    abandonAt: ABANDON_AT,
    ...overrides,
  } as unknown as ClerkSignUp;
}

const pending: SignUpSnapshot = {
  kind: 'pending',
  id: asSignUpAttemptId(ATTEMPT_ID),
  email: EMAIL,
  strategy: 'email_code',
  emailUnverified: true,
  codeSpent: false,
  codeExpiresAt: asEpochMs(CODE_EXPIRES_AT),
  abandonAt: asEpochMs(ABANDON_AT),
};

function input(overrides: Partial<ResumeInput> = {}, signUp: Partial<Extract<SignUpSnapshot, { kind: 'pending' }>> = {}): ResumeInput {
  return {
    signUp: { ...pending, ...signUp },
    trigger: 'hydration',
    signedIn: false,
    dismissedAttemptId: null,
    clerkModalOpen: false,
    ...overrides,
  };
}

describe('readSignUpSnapshot', () => {
  it('parses the captured production attempt into a pending snapshot', () => {
    assert.deepEqual(readSignUpSnapshot(capturedSignUp()), pending);
  });

  it('maps no attempt, a missing id and an abandoned attempt to none', () => {
    assert.deepEqual(readSignUpSnapshot(undefined), { kind: 'none' });
    assert.deepEqual(readSignUpSnapshot(capturedSignUp({ status: null })), { kind: 'none' });
    assert.deepEqual(readSignUpSnapshot(capturedSignUp({ id: undefined })), { kind: 'none' });
    assert.deepEqual(readSignUpSnapshot(capturedSignUp({ status: 'abandoned' })), { kind: 'none' });
  });

  it('maps a completed attempt to complete with its id', () => {
    assert.deepEqual(readSignUpSnapshot(capturedSignUp({ status: 'complete' })), {
      kind: 'complete',
      id: ATTEMPT_ID,
    });
  });

  // Captured on the #8665 preview: once the code lapses Clerk reports the
  // verification as 'expired', not 'unverified'; 'failed' is too many attempts.
  for (const status of ['expired', 'failed'] as const) {
    it(`reads a '${status}' verification as a still-unverified email with a spent code`, () => {
      const snap = readSignUpSnapshot(capturedSignUp({
        verifications: { emailAddress: { status, strategy: 'email_code', attempts: 1, expireAt: new Date(CODE_EXPIRES_AT) } },
      }));
      assert.deepEqual(snap, { ...pending, codeSpent: true });
    });
  }

  it('keeps a null expireAt as null and reads emailUnverified from both fields', () => {
    const snap = readSignUpSnapshot(capturedSignUp({
      verifications: { emailAddress: { status: 'verified', strategy: 'email_code', attempts: 1, expireAt: null } },
    }));
    assert.equal(snap.kind, 'pending');
    assert.equal((snap as Extract<SignUpSnapshot, { kind: 'pending' }>).codeExpiresAt, null);
    assert.equal((snap as Extract<SignUpSnapshot, { kind: 'pending' }>).emailUnverified, false);
  });
});

describe('decideResume', () => {
  const now = asEpochMs(NOW);
  const resumeLive = { kind: 'resume', attemptId: ATTEMPT_ID, email: EMAIL, code: 'live' };

  it('resumes the captured attempt with a live code', () => {
    assert.deepEqual(decideResume(input(), now), resumeLive);
  });

  const table: Array<[string, ResumeInput, number, unknown]> = [
    ['signed in wins over everything', input({ signedIn: true, clerkModalOpen: true }), NOW, { kind: 'none', reason: 'signed-in' }],
    ['no attempt', input({ signUp: { kind: 'none' } }), NOW, { kind: 'none', reason: 'no-attempt' }],
    ['completed attempt', input({ signUp: { kind: 'complete', id: asSignUpAttemptId(ATTEMPT_ID) } }), NOW, { kind: 'none', reason: 'complete' }],
    ['email link strategy', input({}, { strategy: 'email_link' }), NOW, { kind: 'none', reason: 'not-email-code' }],
    ['email already verified', input({}, { emailUnverified: false }), NOW, { kind: 'none', reason: 'email-already-verified' }],
    ['abandonAt reached', input(), ABANDON_AT, { kind: 'none', reason: 'abandoned' }],
    ['abandonAt null is alive past the old deadline', input({}, { abandonAt: null }), ABANDON_AT + 1, { ...resumeLive, code: 'expired' }],
    ['dismissed this attempt', input({ dismissedAttemptId: asSignUpAttemptId(ATTEMPT_ID) }), NOW, { kind: 'none', reason: 'dismissed' }],
    ['a click resumes a dismissed attempt', input({ trigger: 'user', dismissedAttemptId: asSignUpAttemptId(ATTEMPT_ID) }), NOW, resumeLive],
    ['dismissed another attempt', input({ dismissedAttemptId: asSignUpAttemptId('sua_other') }), NOW, resumeLive],
    ["Clerk's own modal is open", input({ clerkModalOpen: true }), NOW, { kind: 'none', reason: 'clerk-modal-open' }],
    ['code past expireAt', input(), CODE_EXPIRES_AT + 1, { ...resumeLive, code: 'expired' }],
    ['code inside the safety margin', input(), CODE_EXPIRES_AT - CODE_EXPIRY_MARGIN_MS, { ...resumeLive, code: 'expired' }],
    ['code just outside the safety margin', input(), CODE_EXPIRES_AT - CODE_EXPIRY_MARGIN_MS - 1, resumeLive],
    ['no expireAt counts as live', input({}, { codeExpiresAt: null }), NOW, resumeLive],
    ['a code Clerk marked spent is expired before its deadline', input({}, { codeSpent: true }), NOW, { ...resumeLive, code: 'expired' }],
  ];

  for (const [name, given, at, expected] of table) {
    it(name, () => {
      assert.deepEqual(decideResume(given, asEpochMs(at)), expected);
    });
  }
});
