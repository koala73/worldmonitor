import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SELFHOST_RELAY_PATHS, isSelfHostRelayPath } from '../shared/selfhost-relay-paths.js';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { API_ONLY_EXACT_PATHS, isApiOnlyPath } from '../server/_shared/api-only-paths.ts';

// The Docker image ships neither src/ nor server/, so the self-host relay reads
// a JS mirror of "premium paths minus API-only paths" (plan 2026-11-04-001,
// KTD6). This suite is what keeps the mirror honest: a path added to either
// source set without updating shared/selfhost-relay-paths.js fails here.
describe('self-host relay path mirror', () => {
  it('equals PREMIUM_RPC_PATHS minus the API-only set', () => {
    const expected = [...PREMIUM_RPC_PATHS].filter((p) => !isApiOnlyPath(p)).sort();
    assert.deepEqual([...SELFHOST_RELAY_PATHS].sort(), expected);
  });

  it('never relays a path desktop keys are denied (REST v2, MCP, OAuth)', () => {
    for (const p of SELFHOST_RELAY_PATHS) {
      assert.equal(isApiOnlyPath(p), false, `${p} is API-only`);
      assert.ok(!p.startsWith('/api/v2/'), `${p} is REST v2`);
    }
    for (const p of [...API_ONLY_EXACT_PATHS, '/api/v2/shipping/route-intelligence', '/api/v2/shipping/webhooks']) {
      assert.equal(isSelfHostRelayPath(p), false, `${p} must not be relayed`);
    }
  });

  it('matches exact paths only', () => {
    assert.equal(isSelfHostRelayPath('/api/chat-analyst'), true);
    assert.equal(isSelfHostRelayPath('/api/chat-analyst/'), false);
    assert.equal(isSelfHostRelayPath('/api/chat-analyst-x'), false);
    assert.equal(isSelfHostRelayPath('/api/market/v1/list-market-quotes'), false);
  });

  it('cannot be mutated at runtime', () => {
    assert.throws(() => (SELFHOST_RELAY_PATHS as Set<string>).add('/api/bootstrap'));
    assert.equal(isSelfHostRelayPath('/api/bootstrap'), false);
  });
});
