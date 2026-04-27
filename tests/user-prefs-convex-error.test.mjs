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
