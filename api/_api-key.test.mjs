import { strict as assert } from 'node:assert';
import test from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
const ENTERPRISE_KEY = 'enterprise-test-key-123';
process.env.WM_SESSION_SECRET = SECRET;
process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;

const { validateApiKey } = await import('./_api-key.js');
const { issueSessionToken } = await import('./_session.js');

function makeReq({ origin, referer, secFetchSite, key } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (referer) headers.set('referer', referer);
  if (secFetchSite) headers.set('sec-fetch-site', secFetchSite);
  if (key) headers.set('x-worldmonitor-key', key);
  return new Request('https://api.worldmonitor.app/api/test', { headers });
}

// ── #3541 regression: header-only signals must NEVER pass ──────────────────

test('#3541: forged Referer alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ referer: 'https://worldmonitor.app/' }));
  assert.equal(r.valid, false);
  assert.equal(r.required, true);
});

test('#3541: forged Sec-Fetch-Site: same-origin alone is rejected (this was the closed-PR bug)', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'same-origin' }));
  assert.equal(r.valid, false);
});

test('#3541: forged Origin: https://worldmonitor.app alone is rejected (no key, no session)', async () => {
  const r = await validateApiKey(makeReq({ origin: 'https://worldmonitor.app' }));
  assert.equal(r.valid, false);
});

test('#3541: combined forged Origin + Sec-Fetch-Site + Referer all together is still rejected', async () => {
  const r = await validateApiKey(makeReq({
    origin: 'https://worldmonitor.app',
    referer: 'https://worldmonitor.app/',
    secFetchSite: 'same-origin',
  }));
  assert.equal(r.valid, false);
});

test('#3541: Sec-Fetch-Site: cross-site alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'cross-site' }));
  assert.equal(r.valid, false);
});

test('#3541: Sec-Fetch-Site: none alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'none' }));
  assert.equal(r.valid, false);
});

// ── Anonymous browser session token (the new trust path) ────────────────────

test('valid wms_ session token from any origin is accepted (forceKey=false)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }));
  assert.equal(r.valid, true);
  assert.equal(r.required, false);
  assert.equal(r.kind, 'session', 'must tag as session — gateway uses kind to decide entitlement bypass');
});

test('PR #3557 review: wms_ session token is REJECTED when forceKey=true (premium endpoints)', async () => {
  // wms_ tokens are anonymous and freely mintable via /api/wm-session — they
  // are NOT proof of a paying user. forceKey=true means the route demands a
  // user-bound credential (Pro Bearer JWT, wm_ user key, or enterprise key).
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }), { forceKey: true });
  assert.equal(r.valid, false);
  assert.equal(r.required, true);
  assert.match(r.error, /Pro authentication/);
});

test('PR #3557 review: wms_ result must NOT carry kind=enterprise (gateway entitlement-bypass anti-regression)', async () => {
  // Gateway skips entitlement check ONLY for kind:'enterprise'. If a future
  // refactor mislabels wms_ as enterprise, anonymous tokens silently unlock
  // premium endpoints. Lock the contract here.
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }));
  assert.notEqual(r.kind, 'enterprise');
});

test('enterprise key carries kind=enterprise (the only key kind that bypasses entitlement)', async () => {
  const r = await validateApiKey(makeReq({ key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
  assert.equal(r.kind, 'enterprise');
});

test('valid wms_ session token works even when Origin is also forged (not redundant — no privilege escalation)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ origin: 'https://evil.example.com', key: token }));
  assert.equal(r.valid, true);
});

test('tampered wms_ token is rejected', async () => {
  const { token } = await issueSessionToken();
  const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
  const r = await validateApiKey(makeReq({ key: tampered }));
  assert.equal(r.valid, false);
  assert.equal(r.error, 'Invalid session token');
});

test('garbage wms_ shape is rejected', async () => {
  const r = await validateApiKey(makeReq({ key: 'wms_garbage' }));
  assert.equal(r.valid, false);
});

// ── Enterprise key (WORLDMONITOR_VALID_KEYS) ────────────────────────────────

test('valid enterprise key is accepted from any origin', async () => {
  const r = await validateApiKey(makeReq({ origin: 'https://evil.example.com', key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
  assert.equal(r.required, true);
});

test('invalid enterprise-shape key is rejected', async () => {
  const r = await validateApiKey(makeReq({ key: 'random-string' }));
  assert.equal(r.valid, false);
});

// ── User API key (wm_-prefix) — gateway handles validation ──────────────────

test('wm_-prefixed user key returns required:true / valid:false so gateway can fall back', async () => {
  // Gateway code at server/gateway.ts:440 does:
  //   if (keyCheck.required && !keyCheck.valid && wmKey.startsWith('wm_')) { ...validateUserApiKey... }
  // So validateApiKey must return that exact shape for wm_ keys to trigger the fallback.
  const r = await validateApiKey(makeReq({ key: 'wm_user_abc123' }));
  assert.equal(r.required, true);
  assert.equal(r.valid, false);
});

// ── Desktop (Tauri) — always requires enterprise key ────────────────────────

test('desktop Tauri origin without key is rejected', async () => {
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost' }));
  assert.equal(r.valid, false);
  assert.equal(r.error, 'API key required for desktop access');
});

test('desktop Tauri origin with valid enterprise key is accepted', async () => {
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost', key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
});

test('desktop Tauri origin with wms_ session token is rejected (desktop must use enterprise key)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost', key: token }));
  assert.equal(r.valid, false);
});

// ── Total absence of credentials ────────────────────────────────────────────

test('completely unauthenticated request is rejected', async () => {
  const r = await validateApiKey(makeReq({}));
  assert.equal(r.valid, false);
  assert.equal(r.required, true);
});

// ── forceKey option ─────────────────────────────────────────────────────────

// forceKey=true behavior is exercised above:
//   - wms_ token + forceKey=true → REJECTED (PR #3557 review fix)
//   - wms_ token + forceKey=false → accepted
//   - enterprise key + forceKey=true → accepted (covered by enterprise tests)
