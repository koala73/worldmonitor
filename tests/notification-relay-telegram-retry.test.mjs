/**
 * Regression test: scripts/notification-relay.cjs sendTelegram() must NOT
 * recurse infinitely on sustained 429 responses.
 *
 * Before the fix, the 429 handler called sendTelegram() unconditionally with
 * no retry counter, creating unbounded recursion during sustained rate
 * limiting. This could stack-overflow the Railway relay process.
 *
 * The fix adds a `_retryCount` parameter (default 0) and bails after one
 * retry. This test exercises the actual function via a mocked global fetch
 * and asserts on call count + return value, so it survives source-formatting
 * changes that don't alter behaviour.
 *
 * Run: node --test tests/notification-relay-telegram-retry.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Stub env vars BEFORE requiring the relay module so the top-of-file
// validation block does not call process.exit(1).
process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.RELAY_SHARED_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

// The relay's runtime deps (`resend`, `convex/browser`) live in
// scripts/package.json and are only installed in the Railway container, so
// they are not on the resolution path when running tests from the repo root.
// Stub them at the loader level — `sendTelegram` only uses `fetch`, not these
// modules, so empty shims are sufficient.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class { constructor() {} } };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { constructor() {} async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

let sendTelegram;
let originalFetch;

before(() => {
  // The relay only starts its poll loop when require.main === module, so
  // requiring it from a test is a side-effect-free import.
  ({ sendTelegram } = require(
    resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  ));
  assert.equal(typeof sendTelegram, 'function', 'sendTelegram export missing');
});

function makeRes(status, body = {}) {
  let cancelled = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    body: { cancel() { cancelled = true; } },
    get _cancelled() { return cancelled; },
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('notification-relay sendTelegram retry discipline', () => {
  it('returns true on first-try 200 (no retry)', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeRes(200, { ok: true });
    };
    const ok = await sendTelegram('user-1', 'chat-1', 'hello');
    assert.equal(ok, true, 'sendTelegram should return true on 200');
    assert.equal(callCount, 1, 'fetch should be called exactly once on 200');
  });

  it('retries once on 429 then succeeds (returns true, fetch called twice)', async () => {
    const responses = [
      makeRes(429, { parameters: { retry_after: 0 } }),
      makeRes(200, { ok: true }),
    ];
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return responses.shift();
    };
    const ok = await sendTelegram('user-1', 'chat-1', 'hello');
    assert.equal(ok, true, '429 → 200 should return true');
    assert.equal(callCount, 2, 'fetch should be called exactly twice (initial + 1 retry)');
  });

  it('bails after exactly one retry on sustained 429 (no infinite recursion)', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeRes(429, { parameters: { retry_after: 0 } });
    };
    const ok = await sendTelegram('user-1', 'chat-1', 'hello');
    assert.equal(ok, false, 'sustained 429 should return false');
    assert.equal(callCount, 2, 'fetch must be called exactly 2 times (initial + 1 retry, then bail)');
  });

  it('cancels the response body on the bail path (no socket leak)', async () => {
    const responses = [];
    globalThis.fetch = async () => {
      const res = makeRes(429, { parameters: { retry_after: 0 } });
      responses.push(res);
      return res;
    };
    await sendTelegram('user-1', 'chat-1', 'hello');
    // The 2nd 429 response is the one that hits the bail branch — its
    // body must be cancelled to free the underlying socket.
    assert.equal(responses.length, 2, 'expected 2 responses (initial + 1 retry)');
    assert.equal(responses[1]._cancelled, true, 'bail-path response body must be cancelled');
  });

  it('returns false on 403 without retry', async () => {
    // 403 triggers deactivateChannel() which itself calls fetch against
    // CONVEX_SITE_URL. We only care about Telegram-API calls here, so
    // count requests by hostname.
    let telegramCalls = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        telegramCalls++;
        return makeRes(403, { description: 'Forbidden: bot was blocked by the user' });
      }
      // deactivateChannel hits Convex — return a benign 200 so the call
      // doesn't throw and pollute this assertion.
      return makeRes(200, { ok: true });
    };
    const ok = await sendTelegram('user-1', 'chat-1', 'hello');
    assert.equal(ok, false, '403 should return false');
    assert.equal(telegramCalls, 1, '403 must not retry the Telegram call');
  });

  it('returns false on 401 without retry', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeRes(401, {});
    };
    const ok = await sendTelegram('user-1', 'chat-1', 'hello');
    assert.equal(ok, false, '401 should return false');
    assert.equal(callCount, 1, '401 must not retry');
  });
});
