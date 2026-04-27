/**
 * Regression test: scripts/notification-relay.cjs sendTelegram() must NOT
 * recurse infinitely on sustained 429 responses.
 *
 * Before the fix, the 429 handler called sendTelegram() unconditionally with
 * no retry counter, creating unbounded recursion during sustained rate limiting.
 * This could stack-overflow the Railway relay process.
 *
 * The fix adds a `_retryCount` parameter (default 0) and bails after one retry.
 *
 * Run: node --test tests/notification-relay-telegram-retry.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

function extractSendTelegram(src) {
  const idx = src.indexOf('async function sendTelegram(');
  assert.ok(idx !== -1, 'sendTelegram not found in notification-relay.cjs');
  const openIdx = src.indexOf('{', idx);
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(idx, i);
}

describe('notification-relay sendTelegram retry discipline', () => {
  const fn = extractSendTelegram(relaySrc);

  it('has a _retryCount parameter defaulting to 0', () => {
    assert.match(
      fn,
      /async function sendTelegram\s*\(\s*\w+,\s*\w+,\s*\w+,\s*_retryCount\s*=\s*0\s*\)/,
      'sendTelegram must accept _retryCount = 0 parameter',
    );
  });

  it('bails and returns false when _retryCount >= 1 (no infinite recursion)', () => {
    // There must be a guard that returns false when retry count is exceeded.
    // The guard code is: if ((_retryCount ?? 0) >= 1) { console.warn(...); return false; }
    assert.match(
      fn,
      /_retryCount.*?\)\s*>=\s*1/,
      'sendTelegram must guard against _retryCount >= 1 to prevent infinite recursion',
    );

    // The guard must return false (not recurse again)
    assert.ok(
      /if\s*\([^)]*_retryCount[^)]*\)\s*>=\s*1/.test(fn),
      'guard if-statement with _retryCount >= 1 check not found',
    );
    assert.ok(
      fn.includes('return false'),
      'guard must return false when retry limit is exceeded',
    );

    // The return false must be INSIDE the guard if-block, not somewhere else
    const guardBlockIdx = fn.indexOf('if ((_retryCount ?? 0) >= 1)');
    assert.ok(guardBlockIdx !== -1, 'guard block not found');
    const afterGuard = fn.slice(guardBlockIdx);
    const returnIdx = afterGuard.indexOf('return false');

    // Find the matching closing brace of the guard block (not the first '}')
    const openBraceIdx = afterGuard.indexOf('{');
    let braceDepth = 0;
    let closingBraceIdx = -1;
    for (let j = openBraceIdx; j < afterGuard.length; j++) {
      if (afterGuard[j] === '{') braceDepth++;
      else if (afterGuard[j] === '}') {
        braceDepth--;
        if (braceDepth === 0) { closingBraceIdx = j; break; }
      }
    }

    assert.ok(
      returnIdx !== -1 && returnIdx < closingBraceIdx,
      'return false must appear before the closing brace of the guard block',
    );
  });

  it('passes incremented retry count on the recursive 429 call', () => {
    // The recursive call inside the 429 block must pass an incremented retry count.
    // Since regex can't easily match nested parens, we verify:
    // 1. sendTelegram is called recursively (the only call site in the 429 block)
    // 2. _retryCount is passed as an argument
    // 3. + 1 is present in the function (the increment)
    const recursiveCallIdx = fn.indexOf('return sendTelegram(');
    assert.ok(recursiveCallIdx !== -1, 'recursive sendTelegram call not found');
    const afterCall = fn.slice(recursiveCallIdx);
    assert.ok(
      /_retryCount/.test(afterCall),
      'recursive call must pass _retryCount parameter',
    );
    assert.ok(
      /\+\s*1/.test(afterCall),
      'recursive call must increment retry count with + 1',
    );
  });

  it('does not recurse for any status code other than 429', () => {
    // Count all sendTelegram( calls inside the function body.
    // There should be exactly 1: the recursive one in the 429 handler.
    const bodyOnly = fn.slice(fn.indexOf('{') + 1, fn.lastIndexOf('}'));
    const allCalls = bodyOnly.match(/sendTelegram\s*\(/g) || [];
    assert.equal(
      allCalls.length, 1,
      `sendTelegram body should contain exactly 1 self-call (the 429 retry); found ${allCalls.length}`,
    );
  });
});
