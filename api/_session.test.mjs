import { strict as assert } from 'node:assert';
import test from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
process.env.WM_SESSION_SECRET = SECRET;

const { issueSessionToken, validateSessionToken, isSessionTokenShape } =
  await import('./_session.js');

test('issueSessionToken returns wms_-prefixed token + future exp', async () => {
  const { token, exp } = await issueSessionToken();
  assert.match(token, /^wms_/);
  assert.ok(exp > Date.now());
  assert.ok(exp - Date.now() <= 12 * 60 * 60 * 1000 + 1000);
});

test('validateSessionToken accepts a freshly-issued token', async () => {
  const { token } = await issueSessionToken();
  assert.equal(await validateSessionToken(token), true);
});

test('validateSessionToken rejects a token signed with a different secret', async () => {
  const { token } = await issueSessionToken();
  const stash = process.env.WM_SESSION_SECRET;
  process.env.WM_SESSION_SECRET = 'different-secret-also-32-chars-or-longer-yyyy';
  try {
    assert.equal(await validateSessionToken(token), false);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
});

test('validateSessionToken rejects a tampered payload', async () => {
  const { token } = await issueSessionToken();
  const m = token.match(/^(wms_)([^.]+)\.(.+)$/);
  const [, prefix, body, sig] = m;
  // Flip a bit in the first decoded byte
  const decoded = Buffer.from(body, 'base64url').toString();
  const tampered = decoded.replace(/^./, c => String.fromCharCode(c.charCodeAt(0) ^ 1));
  const tamperedBody = Buffer.from(tampered).toString('base64url');
  const forged = `${prefix}${tamperedBody}.${sig}`;
  assert.equal(await validateSessionToken(forged), false);
});

test('validateSessionToken rejects a tampered signature', async () => {
  const { token } = await issueSessionToken();
  // Flip last char in signature
  const flipped = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
  assert.equal(await validateSessionToken(flipped), false);
});

test('validateSessionToken rejects an expired token', async () => {
  // Build an expired token using the SAME secret + Web Crypto so the sig matches.
  const enc = new TextEncoder();
  const past = Date.now() - 1000;
  const body = Buffer.from(JSON.stringify({ iat: past - 1000, exp: past, n: 'aabbccdd' })).toString('base64url');
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sig = Buffer.from(new Uint8Array(sigBuf)).toString('base64url');
  const expired = `wms_${body}.${sig}`;
  assert.equal(await validateSessionToken(expired), false);
});

test('validateSessionToken rejects garbage input', async () => {
  assert.equal(await validateSessionToken(''), false);
  assert.equal(await validateSessionToken('not-a-token'), false);
  assert.equal(await validateSessionToken('wms_'), false);
  assert.equal(await validateSessionToken('wms_no-dot'), false);
  assert.equal(await validateSessionToken('wms_a.'), false);
  assert.equal(await validateSessionToken('wms_.b'), false);
  assert.equal(await validateSessionToken(null), false);
  assert.equal(await validateSessionToken(undefined), false);
  assert.equal(await validateSessionToken(123), false);
});

test('isSessionTokenShape only matches wms_ prefix', () => {
  assert.equal(isSessionTokenShape('wms_abc'), true);
  assert.equal(isSessionTokenShape('wm_userkey'), false);
  assert.equal(isSessionTokenShape('enterprise-key'), false);
  assert.equal(isSessionTokenShape(''), false);
  assert.equal(isSessionTokenShape(null), false);
});

test('issueSessionToken throws when WM_SESSION_SECRET is missing/short (fail closed)', async () => {
  const stash = process.env.WM_SESSION_SECRET;
  process.env.WM_SESSION_SECRET = 'too-short';
  try {
    await assert.rejects(() => issueSessionToken(), /WM_SESSION_SECRET/);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
  delete process.env.WM_SESSION_SECRET;
  try {
    await assert.rejects(() => issueSessionToken(), /WM_SESSION_SECRET/);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
});

test('validateSessionToken returns false (not throws) when secret missing', async () => {
  const { token } = await issueSessionToken();
  const stash = process.env.WM_SESSION_SECRET;
  delete process.env.WM_SESSION_SECRET;
  try {
    assert.equal(await validateSessionToken(token), false);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
});
