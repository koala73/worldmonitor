import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeniedRpcError } from '../src/services/country-brief-error';

// The country MCP App shows a denied section as "locked". MCP 2026-07-28
// clients receive -31002 where 2025-era clients receive -32002 (KTD5), so both
// codes must lock the section, whatever the message says.
it('treats the authentication and entitlement codes of both MCP eras as denied', () => {
  for (const code of [-32001, -32002, -31002]) {
    assert.equal(isDeniedRpcError({ code, message: 'This tool requires a user-bound credential.' }), true, String(code));
  }
});

it('treats a denial-worded message as denied and anything else as unavailable', () => {
  assert.equal(isDeniedRpcError({ code: -32603, message: 'subscription lapsed' }), true);
  assert.equal(isDeniedRpcError({ code: -32603, message: 'Internal error: data fetch failed' }), false);
  assert.equal(isDeniedRpcError({ code: -31029, message: 'Rate limit exceeded' }), false);
});
