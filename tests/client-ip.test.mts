import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getClientIp as getServerClientIp } from '../server/_shared/client-ip.ts';
import { getClientIp as getApiClientIp } from '../api/_client-ip.js';

function makeRequest(proof: string): Request {
  return new Request('https://worldmonitor.app/api/test', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-wm-edge-proof': proof,
    },
  });
}

function compareWithCharCodeCount(
  getClientIp: (request: Request) => string,
  proof: string,
  secret: string,
): { ip: string; proofReads: number; secretReads: number } {
  const request = makeRequest(proof);
  const originalCharCodeAt = String.prototype.charCodeAt;
  let proofReads = 0;
  let secretReads = 0;

  String.prototype.charCodeAt = function (this: string, index: number): number {
    const value = String(this);
    if (value === proof) proofReads += 1;
    if (value === secret) secretReads += 1;
    return originalCharCodeAt.call(this, index);
  };

  try {
    return { ip: getClientIp(request), proofReads, secretReads };
  } finally {
    String.prototype.charCodeAt = originalCharCodeAt;
  }
}

describe('client-IP edge-proof comparison (#5239)', () => {
  it('uses the secret length for short and long invalid proofs in both sync mirrors', () => {
    const secret = 'edge-secret-xyz';
    const proofs = ['short', 'edge-secret-xyz-with-extra'];
    const originalSecret = process.env.CF_EDGE_PROOF_SECRET;
    process.env.CF_EDGE_PROOF_SECRET = secret;

    try {
      for (const getClientIp of [getServerClientIp, getApiClientIp]) {
        for (const proof of proofs) {
          const comparison = compareWithCharCodeCount(getClientIp, proof, secret);
          assert.equal(comparison.ip, '192.0.2.5');
          assert.equal(comparison.proofReads, secret.length);
          assert.equal(comparison.secretReads, secret.length);
        }
      }
    } finally {
      if (originalSecret == null) delete process.env.CF_EDGE_PROOF_SECRET;
      else process.env.CF_EDGE_PROOF_SECRET = originalSecret;
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
