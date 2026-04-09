'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

const KEY_ENV = 'NOTIFICATION_ENCRYPTION_KEY';
const VERSION = 'v1';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(version) {
  if (version === 'v1') {
    const raw = process.env[KEY_ENV];
    if (!raw) throw new Error(`${KEY_ENV} is not set`);
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes for AES-256 (got ${key.length})`);
    return key;
  }
  throw new Error(`Unknown key version: ${version}`);
}

function encrypt(plaintext) {
  const key = getKey(VERSION);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);
  return `${VERSION}:${payload.toString('base64')}`;
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

module.exports = { encrypt, decrypt };
