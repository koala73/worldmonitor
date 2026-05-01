import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

  it('includes the ticker id in HTTP errors', async () => {
    await assert.rejects(
      fetchCoinPaprikaTickersById(['bad-token'], {
        fetchFn: async () => ({ ok: false, status: 404 }),
      }),
      /CoinPaprika bad-token HTTP 404/,
    );
  });
});
