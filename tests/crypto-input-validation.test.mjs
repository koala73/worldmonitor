import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  keyFingerprint,
  sha256Hex,
  timingSafeEqualSecret,
  timingSafeIncludes,
} from '../api/_crypto.js';

const NON_STRING_VALUES = [null, undefined, 123, true, {}, []];

describe('crypto helper input validation (#5529)', () => {
  it('preserves hashes and fingerprints for string inputs', async () => {
    assert.equal(
      await sha256Hex('test-string'),
      'ffe65f1d98fafedea3514adc956c8ada5980c6c5d2552fd61f48401aefd5c00e',
    );
    assert.equal(await keyFingerprint('my-secret-key'), '1311f8fc80a7ea28');
    assert.equal((await sha256Hex(''))?.length, 64);
  });

  it('rejects non-string hash inputs without throwing', async () => {
    for (const value of NON_STRING_VALUES) {
      assert.equal(await sha256Hex(value), null);
      assert.equal(await keyFingerprint(value), null);
    }
  });

  it('preserves timing-safe allowlist behavior for valid strings', async () => {
    assert.equal(await timingSafeIncludes('secret', ['wrong', 'secret', 'another']), true);
    assert.equal(await timingSafeIncludes('secret', ['wrong', 'another']), false);
    assert.equal(await timingSafeEqualSecret('secret', 'secret'), true);
    assert.equal(await timingSafeEqualSecret('secret', 'wrong'), false);
  });

  it('rejects non-array allowlists without throwing', async () => {
    for (const validKeys of [null, undefined, {}, { 0: 'secret', length: 1 }, 'secret', 123, true]) {
      assert.equal(await timingSafeIncludes('secret', validKeys), false);
    }
  });

  it('rejects non-string candidates and allowlist entries without coercion', async () => {
    for (const candidate of NON_STRING_VALUES) {
      assert.equal(await timingSafeIncludes(candidate, ['[object Object]', '123', 'true']), false);
      assert.equal(await timingSafeEqualSecret(candidate, '[object Object]'), false);
    }

    for (const validKeys of [[{}], [123], [true], ['secret', null]]) {
      assert.equal(await timingSafeIncludes('secret', validKeys), false);
    }
  });
});
