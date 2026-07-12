import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { getClientIp as getServerClientIp } from '../server/_shared/client-ip.ts';
import { getClientIp as getApiClientIp } from '../api/_client-ip.js';

const SOURCE_FILES = [
  'server/_shared/client-ip.ts',
  'api/_client-ip.js',
] as const;

function makeRequest(proof: string): Request {
  return new Request('https://worldmonitor.app/api/test', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-wm-edge-proof': proof,
    },
  });
}

describe('client-IP edge-proof comparison (#5239)', () => {
  it('does not retain an unequal-length early return in either sync mirror', () => {
    for (const file of SOURCE_FILES) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /a\.length !== b\.length\) return false/);
      assert.match(source, /const len = b\.length;/);
      assert.match(source, /let diff = a\.length \^ b\.length;/);
    }
  });

  it('keeps valid, mismatched-length, and wrong-value proofs semantically identical', () => {
    const originalSecret = process.env.CF_EDGE_PROOF_SECRET;
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

    try {
      for (const getClientIp of [getServerClientIp, getApiClientIp]) {
        assert.equal(getClientIp(makeRequest('edge-secret-xyz')), '203.0.113.7');
        assert.equal(getClientIp(makeRequest('short')), '192.0.2.5');
        assert.equal(getClientIp(makeRequest('edge-secret-xyz-with-extra')), '192.0.2.5');
        assert.equal(getClientIp(makeRequest('edge-secret-xyq')), '192.0.2.5');
      }
    } finally {
      if (originalSecret == null) delete process.env.CF_EDGE_PROOF_SECRET;
      else process.env.CF_EDGE_PROOF_SECRET = originalSecret;
    }
  });
});
