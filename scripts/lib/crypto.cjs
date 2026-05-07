'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

const LEGACY_KEY_ENV = 'NOTIFICATION_ENCRYPTION_KEY';
const IV_LEN = 12;
const TAG_LEN = 16;

// Versioned key env vars: ENCRYPTION_KEY_V1, ENCRYPTION_KEY_V2, ...
// Falls back to NOTIFICATION_ENCRYPTION_KEY for v1 (backwards-compatible).
const KEY_ENV_PREFIX = 'ENCRYPTION_KEY_V';

function getLatestVersion() {
  for (let v = 99; v >= 1; v--) {
    if (process.env[`${KEY_ENV_PREFIX}${v}`]) return `v${v}`;
  }
  if (process.env[LEGACY_KEY_ENV]) return 'v1';
  throw new Error('No encryption key configured (set ENCRYPTION_KEY_V1 or NOTIFICATION_ENCRYPTION_KEY)');
}

function getKey(version) {
  const num = parseInt(version.slice(1), 10);
  if (!num || num < 1) throw new Error(`Unknown key version: ${version}`);

  const raw = process.env[`${KEY_ENV_PREFIX}${num}`]
    || (num === 1 ? process.env[LEGACY_KEY_ENV] : undefined);

  if (!raw) throw new Error(`No key for ${version} (set ${KEY_ENV_PREFIX}${num})`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${KEY_ENV_PREFIX}${num} must be 32 bytes for AES-256 (got ${key.length})`);
  return key;
}

function encrypt(plaintext) {
  const version = getLatestVersion();
  const key = getKey(version);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);
  return `${version}:${payload.toString('base64')}`;
}

function decrypt(stored) {
  const colon = stored.indexOf(':');
  if (colon === -1) throw new Error('Invalid envelope: missing version prefix');
  const version = stored.slice(0, colon);
  const key = getKey(version);
  const payload = Buffer.from(stored.slice(colon + 1), 'base64');
  if (payload.length < IV_LEN + TAG_LEN) throw new Error('Invalid envelope: too short');
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, getLatestVersion };
