import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { wtoFetch } from '../scripts/seed-supply-chain-trade.mjs';

const ORIG_FETCH = globalThis.fetch;
const ORIG_API_KEY = process.env.WTO_API_KEY;

beforeEach(() => {
  process.env.WTO_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_API_KEY === undefined) delete process.env.WTO_API_KEY;
  else process.env.WTO_API_KEY = ORIG_API_KEY;
});

describe('wtoFetch: resilience contract — returns null on every failure mode', () => {
  it('returns null when fetch rejects with AbortError (timeout)', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840,124,156' });
    assert.equal(result, null, 'timeout must produce null, not throw');
  });

  it('returns null when fetch rejects with a network error', async () => {
    globalThis.fetch = async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null, 'network error must produce null, not throw');
  });

  it('returns null on HTTP 5xx', async () => {
    globalThis.fetch = async () => new Response('upstream down', { status: 503 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns null on HTTP 401 (auth) — stays graceful, does not crash the bundle', async () => {
    globalThis.fetch = async () => new Response('{"statusCode":401}', { status: 401 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns {Dataset: []} on HTTP 204 (no content for the query)', async () => {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '999' });
    assert.deepEqual(result, { Dataset: [] });
  });

  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ Dataset: [{ ReportingEconomyCode: '840', Year: 2025, Value: 3.4 }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(Array.isArray(result?.Dataset), true);
    assert.equal(result.Dataset[0].ReportingEconomyCode, '840');
  });

  it('returns null when JSON parse fails (truncated response)', async () => {
    globalThis.fetch = async () => new Response('{"Dataset":[{"R', { status: 200 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns null when WTO_API_KEY is unset', async () => {
    delete process.env.WTO_API_KEY;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
    assert.equal(fetchCalled, false, 'must short-circuit before fetch when key is missing');
  });
});

describe('wtoFetch: per-batch isolation simulating fetchTariffTrends loop', () => {
  // Reproduces the 2026-05-01 06:08 incident: one of N sequential batches
  // times out. Pre-fix, this propagated up and rejected the whole
  // fetchTariffTrends, making `Promise.allSettled` see status='rejected'
  // and skip ALL writeExtraKeyWithMeta calls. Post-fix, the bad batch
  // becomes a null result and the loop's `if (!data) continue` handles it.
  it('one batch timing out does not prevent other batches from yielding data', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 3) {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({
        Dataset: [{ ReportingEconomyCode: '840', Year: 2025, Value: 3.4 }],
      }), { status: 200 });
    };

    // Simulate the loop pattern fetchTariffTrends uses
    const results = [];
    for (let i = 0; i < 5; i++) {
      const data = await wtoFetch('/data', { i: 'TP_A_0010', r: '840,124,156' });
      if (!data) continue;
      results.push(data);
    }

    assert.equal(callCount, 5, 'all 5 batches must be attempted');
    assert.equal(results.length, 4, '4 batches must yield data; the timed-out one is silently skipped');
  });
});
