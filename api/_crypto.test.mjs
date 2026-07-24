/**
 * Tests for api/_crypto.js defensive input validation
 *
 * Coverage focus:
 *   - sha256Hex rejects non-string inputs with TypeError
 *   - keyFingerprint rejects non-string inputs with TypeError
 *   - timingSafeIncludes handles invalid array inputs gracefully (returns false)
 *   - timingSafeEqualSecret handles invalid inputs gracefully
 *   - verifyPkceS256 returns null for invalid inputs (existing behavior preserved)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex, keyFingerprint, timingSafeIncludes, timingSafeEqualSecret, verifyPkceS256 } from './_crypto.js';

describe('sha256Hex input validation', () => {
  it('returns hex string for valid input', async () => {
    const result = await sha256Hex('test-string');
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 64); // SHA-256 = 256 bits = 64 hex chars
    assert.match(result, /^[0-9a-f]+$/);
  });

  it('throws TypeError for null input', async () => {
    await assert.rejects(
      sha256Hex(null),
      { name: 'TypeError', message: 'sha256Hex requires a string input' }
    );
  });

  it('throws TypeError for undefined input', async () => {
    await assert.rejects(
      sha256Hex(undefined),
      { name: 'TypeError', message: 'sha256Hex requires a string input' }
    );
  });

  it('throws TypeError for number input', async () => {
    await assert.rejects(
      sha256Hex(12345),
      { name: 'TypeError', message: 'sha256Hex requires a string input' }
    );
  });

  it('throws TypeError for object input', async () => {
    await assert.rejects(
      sha256Hex({}),
      { name: 'TypeError', message: 'sha256Hex requires a string input' }
    );
  });

  it('accepts empty string', async () => {
    const result = await sha256Hex('');
    assert.equal(result.length, 64);
  });
});

describe('keyFingerprint input validation', () => {
  it('returns 16-char fingerprint for valid key', async () => {
    const result = await keyFingerprint('my-secret-key');
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 16);
  });

  it('throws TypeError for null input', async () => {
    await assert.rejects(
      keyFingerprint(null),
      { name: 'TypeError', message: 'keyFingerprint requires a string key' }
    );
  });

  it('throws TypeError for undefined input', async () => {
    await assert.rejects(
      keyFingerprint(undefined),
      { name: 'TypeError', message: 'keyFingerprint requires a string key' }
    );
  });

  it('throws TypeError for number input', async () => {
    await assert.rejects(
      keyFingerprint(12345),
      { name: 'TypeError', message: 'keyFingerprint requires a string key' }
    );
  });
});

describe('timingSafeIncludes input validation', () => {
  it('returns true when candidate matches a key', async () => {
    const result = await timingSafeIncludes('secret', ['wrong', 'secret', 'another']);
    assert.equal(result, true);
  });

  it('returns false when candidate does not match any key', async () => {
    const result = await timingSafeIncludes('secret', ['wrong', 'another', 'foo']);
    assert.equal(result, false);
  });

  it('returns false for null validKeys (instead of crashing)', async () => {
    const result = await timingSafeIncludes('secret', null);
    assert.equal(result, false);
  });

  it('returns false for undefined validKeys (instead of crashing)', async () => {
    const result = await timingSafeIncludes('secret', undefined);
    assert.equal(result, false);
  });

  it('returns false for object masquerading as array (instead of crashing)', async () => {
    const result = await timingSafeIncludes('secret', { 0: 'secret', length: 1 });
    assert.equal(result, false);
  });

  it('returns false for empty array', async () => {
    const result = await timingSafeIncludes('secret', []);
    assert.equal(result, false);
  });

  it('returns false for null candidate', async () => {
    const result = await timingSafeIncludes(null, ['secret']);
    assert.equal(result, false);
  });

  it('returns false for undefined candidate', async () => {
    const result = await timingSafeIncludes(undefined, ['secret']);
    assert.equal(result, false);
  });
});

describe('timingSafeEqualSecret input validation', () => {
  it('returns true when values match', async () => {
    const result = await timingSafeEqualSecret('secret', 'secret');
    assert.equal(result, true);
  });

  it('returns false when values do not match', async () => {
    const result = await timingSafeEqualSecret('secret', 'wrong');
    assert.equal(result, false);
  });

  it('returns false for null candidate', async () => {
    const result = await timingSafeEqualSecret(null, 'secret');
    assert.equal(result, false);
  });

  it('returns false for null expected', async () => {
    const result = await timingSafeEqualSecret('secret', null);
    assert.equal(result, false);
  });
});

describe('verifyPkceS256 existing validation', () => {
  it('returns null for null codeVerifier', async () => {
    const result = await verifyPkceS256(null, 'somesecretvalue');
    assert.equal(result, null);
  });

  it('returns null for null codeChallenge', async () => {
    const validVerifier = 'a'.repeat(64);
    const result = await verifyPkceS256(validVerifier, null);
    assert.equal(result, null);
  });

  it('returns null for verifier too short', async () => {
    const result = await verifyPkceS256('short', 'somesecretvalue');
    assert.equal(result, null);
  });

  it('returns null for verifier too long', async () => {
    const result = await verifyPkceS256('a'.repeat(129), 'somesecretvalue');
    assert.equal(result, null);
  });

  it('returns false for wrong verifier (valid format but mismatch)', async () => {
    // Create a valid challenge for a different verifier
    const wrongVerifier = 'b'.repeat(64);
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update('a'.repeat(64)).digest();
    const correctChallenge = hash
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = await verifyPkceS256('b'.repeat(64), correctChallenge);
    assert.equal(result, false);
  });
});