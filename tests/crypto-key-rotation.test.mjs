import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);

/**
 * Tests the multi-version key rotation support in scripts/lib/crypto.cjs.
 * (Issue #2906 item 2)
 */

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');

const savedEnv = {};

function setEnv(overrides) {
  for (const key of ['NOTIFICATION_ENCRYPTION_KEY', 'ENCRYPTION_KEY_V1', 'ENCRYPTION_KEY_V2']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
}

function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function loadCrypto() {
  const modPath = require.resolve('../scripts/lib/crypto.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

describe('crypto key rotation', () => {
  afterEach(restoreEnv);

  it('legacy single-key: encrypt/decrypt round-trip with NOTIFICATION_ENCRYPTION_KEY', () => {
    setEnv({ NOTIFICATION_ENCRYPTION_KEY: KEY_V1 });
    const { encrypt, decrypt } = loadCrypto();
    const ciphertext = encrypt('hello world');
    assert.ok(ciphertext.startsWith('v1:'), 'envelope should use v1 prefix');
    assert.equal(decrypt(ciphertext), 'hello world');
  });

  it('versioned key: ENCRYPTION_KEY_V1 works the same as legacy', () => {
    setEnv({ ENCRYPTION_KEY_V1: KEY_V1 });
    const { encrypt, decrypt } = loadCrypto();
    const ciphertext = encrypt('test');
    assert.ok(ciphertext.startsWith('v1:'));
    assert.equal(decrypt(ciphertext), 'test');
  });

  it('encrypt uses latest version (v2) when ENCRYPTION_KEY_V2 is set', () => {
    setEnv({ ENCRYPTION_KEY_V1: KEY_V1, ENCRYPTION_KEY_V2: KEY_V2 });
    const { encrypt } = loadCrypto();
    const ciphertext = encrypt('secret');
    assert.ok(ciphertext.startsWith('v2:'), 'should encrypt with v2 when available');
  });

  it('decrypt can read v1 data even after v2 is the latest', () => {
    setEnv({ ENCRYPTION_KEY_V1: KEY_V1 });
    const { encrypt: encryptV1 } = loadCrypto();
    const v1Cipher = encryptV1('legacy data');

    setEnv({ ENCRYPTION_KEY_V1: KEY_V1, ENCRYPTION_KEY_V2: KEY_V2 });
    const { decrypt } = loadCrypto();
    assert.equal(decrypt(v1Cipher), 'legacy data');
  });

  it('v2 encrypted data is not decryptable with only v1 key', () => {
    setEnv({ ENCRYPTION_KEY_V1: KEY_V1, ENCRYPTION_KEY_V2: KEY_V2 });
    const { encrypt } = loadCrypto();
    const v2Cipher = encrypt('new data');

    setEnv({ ENCRYPTION_KEY_V1: KEY_V1 });
    const { decrypt } = loadCrypto();
    assert.throws(() => decrypt(v2Cipher), /No key for v2/);
  });

  it('getLatestVersion returns highest available version', () => {
    setEnv({ ENCRYPTION_KEY_V1: KEY_V1, ENCRYPTION_KEY_V2: KEY_V2 });
    const { getLatestVersion } = loadCrypto();
    assert.equal(getLatestVersion(), 'v2');
  });

  it('throws when no key is configured at all', () => {
    setEnv({});
    const { encrypt } = loadCrypto();
    assert.throws(() => encrypt('x'), /No encryption key configured/);
  });
});
