import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  getClientIp as getServerClientIp,
  resetEdgeProofMismatchWarnedForTest as resetServer,
} from '../server/_shared/client-ip.ts';
import {
  getClientIp as getApiClientIp,
  resetEdgeProofMismatchWarnedForTest as resetApi,
} from '../api/_client-ip.js';

let originalWarn: typeof console.warn | null = null;

afterEach(() => {
  if (originalWarn !== null) {
    console.warn = originalWarn;
    originalWarn = null;
  }
  delete process.env.CF_EDGE_PROOF_SECRET;
});

function makeRequest(proof: string, xRealIp = '192.0.2.5'): Request {
  return new Request('https://worldmonitor.app/api/test', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': xRealIp,
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

describe('client-IP proof-mismatch canary (#6431)', () => {
  it('does not warn or consume the latch for a direct-origin spoof', () => {
    let warnings = 0;
    originalWarn = console.warn;
    console.warn = () => { warnings += 1; };
    resetServer();
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

    assert.equal(getServerClientIp(makeRequest('wrong')), '192.0.2.5');
    assert.equal(getApiClientIp(makeRequest('', '203.0.113.10')), '203.0.113.10');
    assert.equal(warnings, 0, 'a non-Cloudflare peer must not warn');

    assert.equal(getApiClientIp(makeRequest('wrong', '173.245.48.1')), '173.245.48.1');
    assert.equal(warnings, 1, 'a later Cloudflare peer mismatch must still warn');
  });

  it('recognizes official Cloudflare IPv4 and IPv6 peers in both mirrors', () => {
    let warnings = 0;
    originalWarn = console.warn;
    console.warn = () => { warnings += 1; };
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

    for (const getClientIp of [getServerClientIp, getApiClientIp]) {
      for (const peerIp of ['173.245.48.1', '2606:4700::1111']) {
        resetServer();
        assert.equal(getClientIp(makeRequest('wrong', peerIp)), peerIp);
        assert.equal(warnings, 1, `${peerIp} must trigger the mismatch canary`);
        warnings = 0;
      }
    }
  });

  it('warns for a Cloudflare peer when the proof secret is unset', () => {
    let warnings = 0;
    originalWarn = console.warn;
    console.warn = () => { warnings += 1; };
    resetServer();
    delete process.env.CF_EDGE_PROOF_SECRET;

    assert.equal(getApiClientIp(makeRequest('', '173.245.48.1')), '173.245.48.1');
    assert.equal(warnings, 1, 'an unset deployment secret must trigger the canary');
  });

  it('shares one warning latch and reset seam across both mirrors', () => {
    let warnings = 0;
    originalWarn = console.warn;
    console.warn = () => { warnings += 1; };
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

    resetServer();
    getServerClientIp(makeRequest('', '173.245.48.1'));
    getApiClientIp(makeRequest('wrong', '173.245.48.2'));
    assert.equal(warnings, 1, 'both mirrors must share one isolate-wide warning');

    resetApi();
    getServerClientIp(makeRequest('wrong', '173.245.48.3'));
    assert.equal(warnings, 2, 'the API reset seam must reset the shared latch');

    resetServer();
    getApiClientIp(makeRequest('wrong', '173.245.48.4'));
    assert.equal(warnings, 3, 'the server reset seam must reset the shared latch');
  });

  it('does not warn when the proof matches (normal transit)', () => {
    for (const { getClientIp, reset } of [
      { getClientIp: getServerClientIp, reset: resetServer },
      { getClientIp: getApiClientIp, reset: resetApi },
    ]) {
      let warnings = 0;
      originalWarn = console.warn;
      console.warn = () => { warnings += 1; };
      try {
        reset();
        process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
        getClientIp(makeRequest('edge-secret-xyz'));
        assert.equal(warnings, 0, 'must not warn when proof matches');
      } finally {
        console.warn = originalWarn;
        originalWarn = null;
        delete process.env.CF_EDGE_PROOF_SECRET;
      }
    }
  });
});
