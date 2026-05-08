import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractConvexErrorKind, readConvexErrorNumber } from '../api/_convex-error.js';

describe('extractConvexErrorKind — Convex client error → kind', () => {
  describe('structured-data path (preferred — server throws ConvexError({ kind, ... }))', () => {
    it('reads CONFLICT from err.data.kind', () => {
      const err = Object.assign(new Error('[Request ID: abc] Server Error'), {
        data: { kind: 'CONFLICT', actualSyncVersion: 13 },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'CONFLICT');
    });

    it('reads BLOB_TOO_LARGE from err.data.kind even when message is generic', () => {
      const err = Object.assign(new Error('[Request ID: xyz] Server Error'), {
        data: { kind: 'BLOB_TOO_LARGE', size: 9999, max: 8192 },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'BLOB_TOO_LARGE');
    });

    it('reads UNAUTHENTICATED from err.data.kind', () => {
      const err = Object.assign(new Error('[Request ID: q] Server Error'), {
        data: { kind: 'UNAUTHENTICATED' },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('returns the kind verbatim for forward-compat new kinds (BAD_REQUEST etc.)', () => {
      const err = Object.assign(new Error('Server Error'), {
        data: { kind: 'NEW_KIND_NOT_YET_HANDLED' },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'NEW_KIND_NOT_YET_HANDLED');
    });
  });

  describe('Convex platform 503 — ServiceUnavailable JSON body', () => {
    it('detects SERVICE_UNAVAILABLE from the {"code":"ServiceUnavailable"} JSON shape', () => {
      // Convex's HTTP runtime returns a JSON body when the deployment is briefly
      // unreachable; the SDK surfaces it as `Error('{"code":"ServiceUnavailable",...}')`
      // with `.data === undefined` (it's transport-layer, not a ConvexError).
      const err = new Error('{"code":"ServiceUnavailable","message":"Service temporarily unavailable"}');
      assert.equal(extractConvexErrorKind(err, err.message), 'SERVICE_UNAVAILABLE');
    });

    it('detects SERVICE_UNAVAILABLE even when the JSON has additional fields', () => {
      const err = new Error('{"code":"ServiceUnavailable","message":"Try again later","retryAfterMs":5000}');
      assert.equal(extractConvexErrorKind(err, err.message), 'SERVICE_UNAVAILABLE');
    });

    it('does NOT match the loose phrase "service unavailable" without the JSON code field', () => {
      // Defensive: the detector keys off the exact JSON-shape `"code":"ServiceUnavailable"`,
      // not the prose. Prevents matching some unrelated upstream that happens to
      // include the words "service unavailable" in a free-form error message.
      const err = new Error('Network error: service unavailable, try again');
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });

    it('structured-data path still wins over SERVICE_UNAVAILABLE substring (forward-compat)', () => {
      // If a future ConvexError sets data.kind explicitly AND the message
      // happens to contain the JSON code (very unlikely but defensive),
      // the structured kind takes precedence.
      const err = Object.assign(new Error('{"code":"ServiceUnavailable","message":"x"}'), {
        data: { kind: 'CONFLICT' },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'CONFLICT');
    });
  });

  describe('Convex platform 401 — Unauthenticated JSON body (OIDC token verification failure)', () => {
    it('detects UNAUTHENTICATED from the {"code":"Unauthenticated"} JSON shape', () => {
      // WORLDMONITOR-PG: when Clerk's OIDC token fails Convex's own
      // verification (token expired between our edge's
      // `validateBearerToken` and Convex's check, or Clerk JWKS rotated),
      // the SDK surfaces a JSON body
      //   `{"code":"Unauthenticated","message":"Could not verify OIDC token claim..."}`
      // The mixed-case `"Unauthenticated"` doesn't match the uppercase
      // legacy substring check, so without the JSON-shape detector this
      // fell into the generic 500 bucket. Map to UNAUTHENTICATED so the
      // edge handler returns 401 and tags as `convex_auth_drift`.
      const err = new Error('{"code":"Unauthenticated","message":"Could not verify OIDC token claim. Check that the token signature is valid and the token hasn\'t expired."}');
      assert.equal(extractConvexErrorKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('detects UNAUTHENTICATED even when the JSON has additional fields', () => {
      const err = new Error('{"code":"Unauthenticated","message":"Token expired","reason":"jwks_rotation"}');
      assert.equal(extractConvexErrorKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('does NOT match the loose phrase "unauthenticated" without the JSON code field', () => {
      // Defensive: the detector keys off the exact JSON-shape `"code":"Unauthenticated"`,
      // not the prose. Prevents matching some unrelated upstream that happens to
      // include the lowercase word in a free-form error message.
      const err = new Error('Network error: user is unauthenticated, please retry');
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });

    it('structured-data path still wins over JSON-shape Unauthenticated (forward-compat)', () => {
      const err = Object.assign(new Error('{"code":"Unauthenticated","message":"x"}'), {
        data: { kind: 'CONFLICT' },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'CONFLICT');
    });
  });

  describe('Convex platform 500 — InternalServerError JSON body (transient runtime failure)', () => {
    it('detects SERVICE_UNAVAILABLE from the {"code":"InternalServerError"} JSON shape', () => {
      // WORLDMONITOR-PG/PH: Convex runtime occasionally surfaces
      //   `{"code":"InternalServerError","message":"Your request couldn't
      //     be completed. Try again later."}`
      // when an action / mutation fails internally. Same retry-with-backoff
      // remediation as ServiceUnavailable, so we map to SERVICE_UNAVAILABLE
      // → 503 + Retry-After. Sentry's `error_shape` classifier still
      // discriminates these two cases via its own msg pattern.
      const err = new Error('{"code":"InternalServerError","message":"Your request couldn\'t be completed. Try again later."}');
      assert.equal(extractConvexErrorKind(err, err.message), 'SERVICE_UNAVAILABLE');
    });

    it('does NOT match the loose phrase "internal server error" without the JSON code field', () => {
      // Defensive: detector keys off the exact JSON shape, not free-form
      // prose, so unrelated upstreams that mention the words don't get
      // bucketed together.
      const err = new Error('upstream returned an internal server error, retrying');
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });

    it('structured-data path still wins over JSON-shape InternalServerError (forward-compat)', () => {
      const err = Object.assign(new Error('{"code":"InternalServerError","message":"x"}'), {
        data: { kind: 'CONFLICT' },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'CONFLICT');
    });
  });

  describe('legacy substring-match fallback (string-data ConvexError that arrived without errorData)', () => {
    it('matches CONFLICT in the message', () => {
      const err = new Error('CONFLICT');
      assert.equal(extractConvexErrorKind(err, err.message), 'CONFLICT');
    });

    it('matches BLOB_TOO_LARGE substring in the message', () => {
      const err = new Error('BLOB_TOO_LARGE: 9999 > 8192');
      assert.equal(extractConvexErrorKind(err, err.message), 'BLOB_TOO_LARGE');
    });

    it('matches UNAUTHENTICATED in the message', () => {
      const err = new Error('UNAUTHENTICATED');
      assert.equal(extractConvexErrorKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('does NOT match a generic "Server Error" message (the bug pre-fix)', () => {
      // This is the exact symptom the structured-data fix exists to address:
      // Convex's `[Request ID: X] Server Error` wrapper used to bypass every
      // catch branch in the edge handler. Confirm the fallback still returns
      // null for it (so the caller treats it as a real 500).
      const err = new Error('[Request ID: 9fee2a2bfa791253] Server Error');
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });
  });

  describe('precedence — structured-data wins over message-substring', () => {
    it('reads .data.kind even if the message contains a different token', () => {
      // Defensive: if a future ConvexError both sets data.kind AND the
      // message string accidentally contains "CONFLICT", structured wins.
      const err = Object.assign(new Error('[Request ID: x] Server Error mentioning CONFLICT'), {
        data: { kind: 'BLOB_TOO_LARGE', size: 9999, max: 8192 },
      });
      assert.equal(extractConvexErrorKind(err, err.message), 'BLOB_TOO_LARGE');
    });
  });

  describe('null returns', () => {
    it('returns null for an unrelated error', () => {
      const err = new Error('TypeError: Failed to fetch');
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });

    it('returns null for err.data without a kind field', () => {
      const err = Object.assign(new Error('msg'), { data: { other: 'x' } });
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });

    it('returns null for non-string kind (e.g. number)', () => {
      const err = Object.assign(new Error('msg'), { data: { kind: 42 } });
      assert.equal(extractConvexErrorKind(err, err.message), null);
    });
  });
});

describe('readConvexErrorNumber — type-guarded numeric field reader', () => {
  it('reads a numeric actualSyncVersion', () => {
    const err = Object.assign(new Error(), { data: { kind: 'CONFLICT', actualSyncVersion: 13 } });
    assert.equal(readConvexErrorNumber(err, 'actualSyncVersion'), 13);
  });

  it('returns undefined for missing fields', () => {
    const err = Object.assign(new Error(), { data: { kind: 'CONFLICT' } });
    assert.equal(readConvexErrorNumber(err, 'actualSyncVersion'), undefined);
  });

  it('returns undefined for non-numeric values (string)', () => {
    // Defensive: prevents a malformed ConvexError(`{ actualSyncVersion: "13" }`)
    // from leaking a string into our 409 response body.
    const err = Object.assign(new Error(), { data: { actualSyncVersion: '13' } });
    assert.equal(readConvexErrorNumber(err, 'actualSyncVersion'), undefined);
  });

  it('returns undefined for null/undefined data', () => {
    assert.equal(readConvexErrorNumber(new Error('no data'), 'actualSyncVersion'), undefined);
    assert.equal(readConvexErrorNumber(undefined, 'actualSyncVersion'), undefined);
  });

  it('preserves zero (a valid number)', () => {
    const err = Object.assign(new Error(), { data: { actualSyncVersion: 0 } });
    assert.equal(readConvexErrorNumber(err, 'actualSyncVersion'), 0);
  });
});
