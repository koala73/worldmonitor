import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchCoinPaprikaTickersById } from '../scripts/_seed-utils.mjs';

describe('fetchCoinPaprikaTickersById', () => {
  it('fetches one configured URL per unique ticker instead of the full catalog', async () => {
    const seen = [];
    const rows = await fetchCoinPaprikaTickersById(['btc-bitcoin', 'eth-ethereum', 'btc-bitcoin'], {
      timeoutMs: 1234,
      fetchFn: async (url, options) => {
        seen.push({ url, options });
        return {
          ok: true,
          async json() {
            return { id: url.match(/tickers\/([^?]+)/)[1], quotes: { USD: { price: 1 } } };
          },
        };
      },
    });

    assert.deepEqual(seen.map((entry) => entry.url), [
      'https://api.coinpaprika.com/v1/tickers/btc-bitcoin?quotes=USD',
      'https://api.coinpaprika.com/v1/tickers/eth-ethereum?quotes=USD',
    ]);
    assert.equal(seen[0].options.headers['User-Agent'].includes('Chrome/'), true);
    assert.equal(rows.length, 2);
  });

  it('keeps successful tickers when one configured id fails', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      const rows = await fetchCoinPaprikaTickersById(['btc-bitcoin', 'bad-token', 'eth-ethereum'], {
        fetchFn: async (url) => {
          const id = url.match(/tickers\/([^?]+)/)[1];
          if (id === 'bad-token') return { ok: false, status: 404 };
          return {
            ok: true,
            async json() {
              return { id, quotes: { USD: { price: 1 } } };
            },
          };
        },
      });

      assert.deepEqual(rows.map((row) => row.id), ['btc-bitcoin', 'eth-ethereum']);
      assert.match(warnings[0], /CoinPaprika bad-token HTTP 404/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('merges custom headers without dropping default CoinPaprika headers', async () => {
    const seen = [];
    await fetchCoinPaprikaTickersById(['btc-bitcoin'], {
      headers: { 'X-Test': '1' },
      fetchFn: async (_url, options) => {
        seen.push(options.headers);
        return {
          ok: true,
          async json() {
            return { id: 'btc-bitcoin', quotes: { USD: { price: 1 } } };
          },
        };
      },
    });

    assert.equal(seen[0].Accept, 'application/json');
    assert.equal(seen[0]['User-Agent'].includes('Chrome/'), true);
    assert.equal(seen[0]['X-Test'], '1');
  });

  it('bounds per-id request fanout', async () => {
    let active = 0;
    let maxActive = 0;
    await fetchCoinPaprikaTickersById(['a-a', 'b-b', 'c-c', 'd-d', 'e-e', 'f-f'], {
      concurrency: 2,
      fetchFn: async (url) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return {
          ok: true,
          async json() {
            return { id: url.match(/tickers\/([^?]+)/)[1], quotes: { USD: { price: 1 } } };
          },
        };
      },
    });

    assert.equal(maxActive, 2);
  });

  it('still fails when every configured ticker request fails', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(
        fetchCoinPaprikaTickersById(['bad-token'], {
          fetchFn: async () => ({ ok: false, status: 404 }),
        }),
        /All 1 CoinPaprika ticker request\(s\) failed/,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('ais-relay CoinPaprika fallback', () => {
  it('does not fetch the full CoinPaprika ticker catalog in the primary market seed path', () => {
    const src = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

    assert.doesNotMatch(src, /api\.coinpaprika\.com\/v1\/tickers\?quotes=USD/);
    assert.match(src, /api\.coinpaprika\.com\/v1\/tickers\/\$\{encodeURIComponent\(id\)\}\?quotes=USD/);
    assert.match(src, /async function _fetchCoinPaprikaTickersById\(paprikaIds\)/);
    assert.match(src, /const _PAPRIKA_FETCH_CONCURRENCY = 4/);
    assert.match(src, /allSettledWithConcurrency\(misses, _PAPRIKA_FETCH_CONCURRENCY/);
  });
});
