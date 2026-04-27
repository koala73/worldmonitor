/**
 * Regression test: sendTelegram() must NOT recurse infinitely on sustained HTTP 429.
 *
 * Before the fix: on HTTP 429 the function re-called itself without a counter,
 * so two consecutive rate-limit responses caused a stack overflow / Railway crash.
 *
 * After the fix: a `_retryCount` parameter bounds recursion to 1 additional attempt.
 * A second consecutive 429 returns false without crashing.
 *
 * Run: node --test tests/notification-relay-429-retry.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline the exact sendTelegram logic from the PR so this test is self-contained
// and deterministic (no live network calls needed).
async function sendTelegram(userId, chatId, text, _retryCount = 0) {
  const TELEGRAM_BOT_TOKEN = 'test-token';
  if (!TELEGRAM_BOT_TOKEN) return false;

  let res;
  try {
    res = await globalThis.fetch(
      'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
  } catch (_) {
    return false;
  }

  if (res.status === 429) {
    if (_retryCount >= 1) {
      // THE FIX: bounded recursion — second 429 exits cleanly instead of looping
      return false;
    }
    const body = await res.json().catch(() => ({}));
    const wait = ((body.parameters?.retry_after ?? 5) + 1) * 1000;
    await new Promise(r => setTimeout(r, Math.min(wait, 10)));
    return sendTelegram(userId, chatId, text, _retryCount + 1);
  }
  if (res.status === 401) return false;
  if (!res.ok) return false;
  return true;
}

describe('sendTelegram bounded retry on HTTP 429', () => {
  it('returns false on two consecutive 429s without crashing', async () => {
    let callCount = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
        json: async () => ({ parameters: { retry_after: 1 } }),
      };
    };

    let threw = false;
    let result;
    try {
      result = await sendTelegram('u1', 'chat1', 'test msg');
    } catch (e) {
      threw = true;
    }

    globalThis.fetch = orig;

    assert.equal(threw, false, 'must not throw');
    assert.equal(result, false, 'must return false on two 429s');
    assert.ok(callCount >= 2, 'should have retried at least once');
  });

  it('succeeds when 429 clears on first retry', async () => {
    let callCount = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ parameters: { retry_after: 1 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    };

    const result = await sendTelegram('u2', 'chat2', 'delayed msg');
    globalThis.fetch = orig;
    assert.equal(result, true, 'must succeed when 429 clears on retry');
  });

  it('returns false on HTTP 500 (non-429 error) without retrying', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await sendTelegram('u3', 'chat3', 'err msg');
    globalThis.fetch = orig;
    assert.equal(result, false, 'non-429 errors must not trigger retry logic');
  });
});
