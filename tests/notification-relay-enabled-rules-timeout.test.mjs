/**
 * Regression test: scripts/notification-relay.cjs's /relay/enabled-rules fetch
 * must be bounded. This call feeds the hot notification path, quiet-hours
 * drain, and flush handler; a stalled Convex HTTP action must fail closed
 * instead of hanging relay work indefinitely.
 *
 * Why source-grep: notification-relay.cjs is a runtime script with minimal
 * exports. Existing relay invariants use source-grep tests for this shape.
 *
 * Run: node --test tests/notification-relay-enabled-rules-timeout.test.mjs
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

describe('notification-relay enabled-rules fetch timeout', () => {
  it('bounds the /relay/enabled-rules fetch with AbortSignal.timeout', () => {
    const match = relaySrc.match(
      /async function fetchEnabledRules[\s\S]*?fetch\(`\$\{CONVEX_SITE_URL\}\/relay\/enabled-rules\?enabled=\$\{enabled\}`,\s*\{([\s\S]*?)\}\);/,
    );
    assert.ok(match, 'fetchEnabledRules /relay/enabled-rules fetch block not found');
    assert.match(
      match[1] ?? '',
      /signal:\s*AbortSignal\.timeout\(10000\)/,
      'fetchEnabledRules must use the same 10s timeout policy as sibling relay Convex HTTP calls',
    );
  });
});
