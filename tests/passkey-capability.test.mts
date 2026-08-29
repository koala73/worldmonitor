/**
 * Coverage for the pure decision surface of the passkey capability service
 * (`src/services/passkeys.ts`).
 *
 * Three things here are load-bearing and would fail silently in production:
 *
 *   1. The environment gate must read ONLY injected facts. This repo has three
 *      disagreeing desktop signals (`desktop-runtime.ts` checks UA + secure
 *      localhost, `push-notifications.ts` checks globals only, and
 *      `AppContext.isDesktopApp` is the canonical one). If the gate reads a
 *      global itself, the explicit Tauri exclusion becomes unverifiable — so
 *      one test deliberately sets `window.__TAURI__` and asserts the verdict
 *      does not move.
 *   2. An unrecognized Clerk error code must classify as `retryable`, never
 *      `failed`. A `failed` verdict ends the attempt and shows the user an
 *      error they cannot act on; a `retryable` misclassification costs one
 *      button press. The asymmetry is the whole point.
 *   3. Clerk surfaces error codes in two shapes — a direct `code` property and
 *      a structured `errors[]` array. Reading only one shape misclassifies half
 *      the vocabulary. Never read `err.constructor.name`: minified bundles
 *      mangle it (a documented hazard in this repo).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPasskeyErrorCode,
  classifyPasskeyFailure,
  countPasskeys,
  isPasskeyEnvironmentEligible,
  isPasskeySessionReady,
  readPasskeyErrorCode,
  resolvePlatformAuthenticator,
} from '../src/services/passkeys.ts';

const ELIGIBLE = { isDesktopApp: false, inIframe: false, hasPublicKeyCredential: true };

describe('isPasskeyEnvironmentEligible', () => {
  it('is eligible when nothing disqualifies the environment', () => {
    assert.equal(isPasskeyEnvironmentEligible(ELIGIBLE), true);
  });

  it('rejects the desktop app (AE5) — passkeys are bound to the web origin', () => {
    assert.equal(isPasskeyEnvironmentEligible({ ...ELIGIBLE, isDesktopApp: true }), false);
  });

  it('rejects an embedded iframe', () => {
    assert.equal(isPasskeyEnvironmentEligible({ ...ELIGIBLE, inIframe: true }), false);
  });

  it('rejects a browser without PublicKeyCredential', () => {
    assert.equal(isPasskeyEnvironmentEligible({ ...ELIGIBLE, hasPublicKeyCredential: false }), false);
  });

  it('reads no globals — a stray window.__TAURI__ cannot move the verdict', () => {
    const g = globalThis as unknown as { window?: Record<string, unknown> };
    const hadWindow = 'window' in g;
    const previous = g.window;
    g.window = { ...(previous ?? {}), __TAURI__: {}, __TAURI_INTERNALS__: {} };
    try {
      // Injected facts say "eligible" while the globals scream "desktop".
      // The gate must believe the injected facts — that is what keeps the
      // desktop exclusion testable at all.
      assert.equal(isPasskeyEnvironmentEligible(ELIGIBLE), true);
      assert.equal(isPasskeyEnvironmentEligible({ ...ELIGIBLE, isDesktopApp: true }), false);
    } finally {
      if (hadWindow) g.window = previous;
      else delete g.window;
    }
  });
});

describe('isPasskeySessionReady', () => {
  const READY = { isSignedIn: true, sessionStatus: 'active', hasCurrentTask: false };

  it('is ready only for an active, task-free, signed-in session', () => {
    assert.equal(isPasskeySessionReady(READY), true);
  });

  it('is not ready while a Clerk task is pending (AE11)', () => {
    assert.equal(isPasskeySessionReady({ ...READY, hasCurrentTask: true }), false);
  });

  it('is not ready when Clerk does not consider the user signed in', () => {
    assert.equal(isPasskeySessionReady({ ...READY, isSignedIn: false }), false);
  });

  it('is not ready for a non-active session status', () => {
    assert.equal(isPasskeySessionReady({ ...READY, sessionStatus: 'pending' }), false);
    assert.equal(isPasskeySessionReady({ ...READY, sessionStatus: null }), false);
  });
});

describe('countPasskeys', () => {
  it('reads zero for an empty passkeys array (AE4)', () => {
    assert.equal(countPasskeys({ passkeys: [] }), 0);
  });

  it('reads zero — not a throw — when passkeys is absent entirely', () => {
    assert.equal(countPasskeys({}), 0);
  });

  it('reads the real length for a user with existing passkeys', () => {
    assert.equal(countPasskeys({ passkeys: [{ id: 'a' }, { id: 'b' }] }), 2);
  });

  it('reads zero when there is no Clerk user at all', () => {
    assert.equal(countPasskeys(null), 0);
    assert.equal(countPasskeys(undefined), 0);
  });
});

describe('readPasskeyErrorCode', () => {
  it('reads a direct code property', () => {
    assert.equal(readPasskeyErrorCode({ code: 'passkey_registration_cancelled' }), 'passkey_registration_cancelled');
  });

  it('reads a code out of a structured errors[] array', () => {
    assert.equal(
      readPasskeyErrorCode({ errors: [{ code: 'passkey_already_exists' }] }),
      'passkey_already_exists',
    );
  });

  it('prefers the direct code when both shapes are present', () => {
    assert.equal(
      readPasskeyErrorCode({ code: 'passkey_not_supported', errors: [{ code: 'passkey_already_exists' }] }),
      'passkey_not_supported',
    );
  });

  it('returns null for a shape it does not recognize, rather than throwing', () => {
    assert.equal(readPasskeyErrorCode(new Error('boom')), null);
    assert.equal(readPasskeyErrorCode(null), null);
    assert.equal(readPasskeyErrorCode('a string'), null);
    assert.equal(readPasskeyErrorCode({ errors: [] }), null);
  });
});

describe('classifyPasskeyErrorCode — the KTD5 table', () => {
  // One row per code in KTD5's table. A code added to the table without a row
  // here is the gap the table is meant to make visible.
  const CREATED = ['passkey_already_exists'];
  const RETRYABLE = [
    'passkey_registration_cancelled',
    'passkey_operation_aborted',
    'passkey_registration_failed',
  ];
  const FAILED = [
    'passkey_not_supported',
    'passkey_pa_not_supported',
    'passkey_invalid_rpID_or_domain',
  ];

  for (const code of CREATED) {
    it(`treats ${code} as created — the account's goal is already met`, () => {
      assert.equal(classifyPasskeyErrorCode(code), 'created');
    });
  }

  for (const code of RETRYABLE) {
    it(`treats ${code} as retryable`, () => {
      assert.equal(classifyPasskeyErrorCode(code), 'retryable');
    });
  }

  for (const code of FAILED) {
    it(`treats ${code} as failed — nothing the user can do on this device`, () => {
      assert.equal(classifyPasskeyErrorCode(code), 'failed');
    });
  }

  it('treats an UNKNOWN code as retryable, never failed (KTD5)', () => {
    assert.equal(classifyPasskeyErrorCode('some_future_clerk_code'), 'retryable');
    assert.equal(classifyPasskeyErrorCode(null), 'retryable');
    assert.equal(classifyPasskeyErrorCode(''), 'retryable');
  });

  it('treats a passkeys-not-enabled server response as retryable, not failed', () => {
    // A misconfigured dashboard is not a device capability verdict. Classifying
    // it as `failed` would show every user an error they cannot act on.
    assert.equal(classifyPasskeyErrorCode('passkeys_not_enabled'), 'retryable');
  });
});

describe('classifyPasskeyFailure', () => {
  it('classifies identically whether the code arrives direct or in errors[]', () => {
    assert.equal(classifyPasskeyFailure({ code: 'passkey_not_supported' }), 'failed');
    assert.equal(classifyPasskeyFailure({ errors: [{ code: 'passkey_not_supported' }] }), 'failed');
  });

  it('falls back to retryable for an error carrying no recognizable code', () => {
    assert.equal(classifyPasskeyFailure(new Error('network blip')), 'retryable');
  });
});

describe('resolvePlatformAuthenticator', () => {
  it('resolves true when the platform authenticator is available', async () => {
    assert.equal(await resolvePlatformAuthenticator(async () => true), true);
  });

  it('resolves false when it is unavailable', async () => {
    assert.equal(await resolvePlatformAuthenticator(async () => false), false);
  });

  it('resolves false rather than throwing when the probe itself rejects', async () => {
    assert.equal(
      await resolvePlatformAuthenticator(async () => { throw new Error('not allowed'); }),
      false,
    );
  });

  it('resolves false when the probe is unavailable on this browser', async () => {
    assert.equal(await resolvePlatformAuthenticator(null), false);
  });
});
