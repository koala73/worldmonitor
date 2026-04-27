import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract `extractConvexErrorKind` from api/user-prefs.ts and run it as a
// standalone function. Avoids importing the whole edge handler (Vercel-runtime
// bindings, Clerk validator, ConvexHttpClient).
const src = readFileSync(resolve(__dirname, '../api/user-prefs.ts'), 'utf-8');
const fnMatch = src.match(/function extractConvexErrorKind\(([\s\S]*?)\): string \| null \{([\s\S]*?)\n\}/);
assert.ok(fnMatch, 'extractConvexErrorKind must exist in api/user-prefs.ts');

const fnBody = fnMatch[2]
  // Strip TS type cast / generic syntax that breaks Function constructor parsing.
  .replace(/as \{ data\?: unknown \}/g, '')
  .replace(/as Record<string, unknown>/g, '');
const fnParams = fnMatch[1].split(',').map(p => p.replace(/:.*/s, '').trim()).filter(Boolean);
// eslint-disable-next-line no-new-func
const extractKind = new Function(...fnParams, fnBody);

describe('extractConvexErrorKind — Convex client error → kind', () => {
  describe('structured-data path (preferred — server throws ConvexError({ kind, ... }))', () => {
    it('reads CONFLICT from err.data.kind', () => {
      const err = Object.assign(new Error('[Request ID: abc] Server Error'), {
        data: { kind: 'CONFLICT', actualSyncVersion: 13 },
      });
      assert.equal(extractKind(err, err.message), 'CONFLICT');
    });

    it('reads BLOB_TOO_LARGE from err.data.kind even when message is generic', () => {
      const err = Object.assign(new Error('[Request ID: xyz] Server Error'), {
        data: { kind: 'BLOB_TOO_LARGE', size: 9999, max: 8192 },
      });
      assert.equal(extractKind(err, err.message), 'BLOB_TOO_LARGE');
    });

    it('reads UNAUTHENTICATED from err.data.kind', () => {
      const err = Object.assign(new Error('[Request ID: q] Server Error'), {
        data: { kind: 'UNAUTHENTICATED' },
      });
      assert.equal(extractKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('returns the kind verbatim for forward-compat new kinds (BAD_REQUEST etc.)', () => {
      const err = Object.assign(new Error('Server Error'), {
        data: { kind: 'NEW_KIND_NOT_YET_HANDLED' },
      });
      assert.equal(extractKind(err, err.message), 'NEW_KIND_NOT_YET_HANDLED');
    });
  });

  describe('legacy substring-match fallback (string-data ConvexError that arrived without errorData)', () => {
    it('matches CONFLICT in the message', () => {
      const err = new Error('CONFLICT');
      assert.equal(extractKind(err, err.message), 'CONFLICT');
    });

    it('matches BLOB_TOO_LARGE substring in the message', () => {
      const err = new Error('BLOB_TOO_LARGE: 9999 > 8192');
      assert.equal(extractKind(err, err.message), 'BLOB_TOO_LARGE');
    });

    it('matches UNAUTHENTICATED in the message', () => {
      const err = new Error('UNAUTHENTICATED');
      assert.equal(extractKind(err, err.message), 'UNAUTHENTICATED');
    });

    it('does NOT match a generic "Server Error" message (the bug pre-fix)', () => {
      // This is the exact symptom the structured-data fix exists to address:
      // Convex's `[Request ID: X] Server Error` wrapper used to bypass every
      // catch branch in the edge handler. Confirm the fallback still returns
      // null for it (so the caller treats it as a real 500).
      const err = new Error('[Request ID: 9fee2a2bfa791253] Server Error');
      assert.equal(extractKind(err, err.message), null);
    });
  });

  describe('precedence — structured-data wins over message-substring', () => {
    it('reads .data.kind even if the message contains a different token', () => {
      // Defensive: if a future ConvexError both sets data.kind AND the
      // message string accidentally contains "CONFLICT", structured wins.
      const err = Object.assign(new Error('[Request ID: x] Server Error mentioning CONFLICT'), {
        data: { kind: 'BLOB_TOO_LARGE', size: 9999, max: 8192 },
      });
      assert.equal(extractKind(err, err.message), 'BLOB_TOO_LARGE');
    });
  });

  describe('null returns', () => {
    it('returns null for an unrelated error', () => {
      const err = new Error('TypeError: Failed to fetch');
      assert.equal(extractKind(err, err.message), null);
    });

    it('returns null for err.data without a kind field', () => {
      const err = Object.assign(new Error('msg'), { data: { other: 'x' } });
      assert.equal(extractKind(err, err.message), null);
    });

    it('returns null for non-string kind (e.g. number)', () => {
      const err = Object.assign(new Error('msg'), { data: { kind: 42 } });
      assert.equal(extractKind(err, err.message), null);
    });
  });
});
